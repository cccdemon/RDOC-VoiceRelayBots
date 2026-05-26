import { Client, Events, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import { PassThrough } from "node:stream";
import type { BotConfig } from "../config.js";

const SILENCE_TIMEOUT_MS = 300;
const RECONNECT_DELAY_MS = 5000;
const JOIN_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 30_000;
const PRESENCE_DEBOUNCE_MS = 500;

export class RelayBot {
  private client: Client;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer;
  private targetChannel: VoiceBasedChannel | null = null;
  private passThrough: PassThrough | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private reconnecting = false;

  constructor(private readonly cfg: BotConfig) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on("error", (err) => {
      console.error(`[${cfg.name}] player error:`, err.message);
    });
  }

  async start(guildId: string): Promise<void> {
    console.log(`[${this.cfg.name}] logging in`);
    await this.client.login(this.cfg.token);
    await this.waitUntilReady();
    console.log(`[${this.cfg.name}] logged in as ${this.client.user?.tag ?? "unknown"}`);

    await this.fetchTargetChannel(guildId);
    this.client.on("voiceStateUpdate", (oldState, newState) => {
      if (oldState.channelId === this.cfg.channelId || newState.channelId === this.cfg.channelId) {
        this.schedulePresenceCheck(guildId);
      }
    });
    await this.syncVoicePresence(guildId);
  }

  private async waitUntilReady(): Promise<void> {
    if (this.client.isReady()) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.off(Events.ClientReady, onReady);
        reject(new Error(`Discord client did not become ready within ${LOGIN_TIMEOUT_MS} ms`));
      }, LOGIN_TIMEOUT_MS);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.client.once(Events.ClientReady, onReady);
    });
  }

  private async fetchTargetChannel(guildId: string): Promise<VoiceBasedChannel | null> {
    if (this.targetChannel) return this.targetChannel;

    console.log(`[${this.cfg.name}] fetching guild ${guildId}`);
    const guild = await this.client.guilds.fetch(guildId);
    await this.syncNickname(guild);
    console.log(`[${this.cfg.name}] fetching channel ${this.cfg.channelId}`);
    const channel = await guild.channels.fetch(this.cfg.channelId);

    if (!channel?.isVoiceBased()) {
      console.error(`[${this.cfg.name}] channel ${this.cfg.channelId} is not a voice channel`);
      return null;
    }

    this.targetChannel = channel as VoiceBasedChannel;
    return this.targetChannel;
  }

  private async syncNickname(guild: VoiceBasedChannel["guild"]): Promise<void> {
    try {
      const member = await guild.members.fetchMe();
      if (member.nickname === this.cfg.name) return;
      await member.setNickname(this.cfg.name, "RDOC voice relay display name");
      console.log(`[${this.cfg.name}] set server nickname`);
    } catch (err) {
      console.warn(`[${this.cfg.name}] could not set server nickname:`, err);
    }
  }

  private schedulePresenceCheck(guildId: string): void {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      void this.syncVoicePresence(guildId);
    }, PRESENCE_DEBOUNCE_MS);
  }

  private async syncVoicePresence(guildId: string): Promise<void> {
    if (this.destroyed) return;
    const channel = await this.fetchTargetChannel(guildId);
    if (!channel) return;

    const hasHumans = channel.members.some((member) => !member.user.bot);
    if (hasHumans) {
      await this.joinChannel(guildId);
      return;
    }

    if (this.connection) {
      console.log(`[${this.cfg.name}] leaving #${channel.name} because no humans are present`);
      this.disconnectVoice();
    } else {
      console.log(`[${this.cfg.name}] waiting outside #${channel.name}; no humans present`);
    }
  }

  private async joinChannel(guildId: string): Promise<void> {
    if (this.destroyed) return;
    if (this.connection) return;
    if (this.reconnecting) return;
    this.reconnecting = true;

    try {
      const channel = await this.fetchTargetChannel(guildId);
      if (!channel) {
        this.reconnecting = false;
        return;
      }

      this.connection = joinVoiceChannel({
        channelId: this.cfg.channelId,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        group: this.client.user?.id ?? this.cfg.name,
        selfDeaf: false,
        selfMute: false,
      });

      await entersState(this.connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
      this.connection.subscribe(this.player);

      this.connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (this.destroyed) return;
        console.warn(`[${this.cfg.name}] voice disconnected - checking whether reconnect is needed`);
        this.connection = null;
        this.reconnecting = false;
        setTimeout(() => void this.syncVoicePresence(guildId), RECONNECT_DELAY_MS);
      });

      console.log(`[${this.cfg.name}] joined #${channel.name}`);
    } catch (err) {
      console.error(`[${this.cfg.name}] join failed:`, err);
      if (!this.destroyed) {
        setTimeout(() => {
          this.reconnecting = false;
          void this.syncVoicePresence(guildId);
        }, RECONNECT_DELAY_MS);
        return;
      }
    }

    this.reconnecting = false;
  }

  private disconnectVoice(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.passThrough?.end();
    this.passThrough = null;
    this.player.stop();
    this.connection?.destroy();
    this.connection = null;
    this.reconnecting = false;
  }

  /**
   * Write a stereo s16le PCM buffer into the bot's audio stream.
   * Creates a fresh PassThrough + AudioResource on the first chunk after
   * idle; ends it after SILENCE_TIMEOUT_MS of inactivity.
   */
  pushPcm(pcm: Buffer): void {
    if (!this.connection || this.destroyed) return;

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (!this.passThrough || this.passThrough.destroyed) {
      this.passThrough = new PassThrough();
      const resource = createAudioResource(this.passThrough, {
        inputType: StreamType.Raw,
      });
      this.player.play(resource);
    }

    this.passThrough.write(pcm);

    // After silence, end the stream so the player returns to Idle state
    // (Discord stops showing the bot as speaking).
    this.silenceTimer = setTimeout(() => {
      this.passThrough?.end();
      this.passThrough = null;
      this.silenceTimer = null;
    }, SILENCE_TIMEOUT_MS);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.disconnectVoice();
    await this.client.destroy();
  }
}

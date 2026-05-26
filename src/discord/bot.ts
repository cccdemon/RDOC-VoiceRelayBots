import { Client, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
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

export class RelayBot {
  private client: Client;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer;
  private passThrough: PassThrough | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
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
    await this.joinChannel(guildId);
  }

  private async waitUntilReady(): Promise<void> {
    if (this.client.isReady()) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.off("ready", onReady);
        reject(new Error(`Discord client did not become ready within ${LOGIN_TIMEOUT_MS} ms`));
      }, LOGIN_TIMEOUT_MS);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.client.once("ready", onReady);
    });
  }

  private async joinChannel(guildId: string): Promise<void> {
    if (this.destroyed) return;
    if (this.reconnecting) return;
    this.reconnecting = true;

    try {
      console.log(`[${this.cfg.name}] fetching guild ${guildId}`);
      const guild = await this.client.guilds.fetch(guildId);
      console.log(`[${this.cfg.name}] fetching channel ${this.cfg.channelId}`);
      const channel = await guild.channels.fetch(this.cfg.channelId);

      if (!channel?.isVoiceBased()) {
        console.error(`[${this.cfg.name}] channel ${this.cfg.channelId} is not a voice channel`);
        this.reconnecting = false;
        return;
      }

      this.connection?.destroy();
      this.connection = joinVoiceChannel({
        channelId: this.cfg.channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      await entersState(this.connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
      this.connection.subscribe(this.player);

      this.connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (this.destroyed) return;
        console.warn(`[${this.cfg.name}] voice disconnected — scheduling reconnect`);
        this.reconnecting = false;
        setTimeout(() => void this.joinChannel(guildId), RECONNECT_DELAY_MS);
      });

      const voiceChannel = channel as VoiceBasedChannel;
      console.log(`[${this.cfg.name}] joined #${voiceChannel.name}`);
    } catch (err) {
      console.error(`[${this.cfg.name}] join failed:`, err);
      if (!this.destroyed) {
        setTimeout(() => {
          this.reconnecting = false;
          void this.joinChannel(guildId);
        }, RECONNECT_DELAY_MS);
        return;
      }
    }

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
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.passThrough?.end();
    this.passThrough = null;
    this.connection?.destroy();
    this.connection = null;
    await this.client.destroy();
  }
}

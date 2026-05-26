import { Room, RoomEvent, TrackKind, type RemoteAudioTrack, type AudioFrame } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

export type PcmHandler = (pcm: Buffer) => void;

const SUBSCRIBER_IDENTITY = "voice-relay-bot-service";
const TOKEN_TTL = 86400; // 24 h — service reconnects on expiry anyway

export class LivekitSubscriber {
  private room: Room;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // Stored for auto-reconnect
  private livekitUrl = "";
  private apiKey = "";
  private apiSecret = "";
  private roomName = "";

  constructor(private readonly onFrame: PcmHandler) {
    this.room = new Room();
  }

  async connect(url: string, apiKey: string, apiSecret: string, roomName: string): Promise<void> {
    this.livekitUrl = url;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.roomName = roomName;

    const token = await mintToken(apiKey, apiSecret, roomName);

    this.room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const audioTrack = track as RemoteAudioTrack;
      // @livekit/rtc-node emits audioFrameReceived on RemoteAudioTrack
      audioTrack.on("audioFrameReceived", (frame: AudioFrame) => {
        this.onFrame(toStereoPcm(frame));
      });
    });

    this.room.on(RoomEvent.Disconnected, () => {
      if (this.destroyed) return;
      console.warn("[LivekitSubscriber] disconnected — reconnecting in 3 s");
      this.reconnectTimer = setTimeout(() => void this.reconnect(), 3000);
    });

    await this.room.connect(url, token);
    console.log(`[LivekitSubscriber] connected to room "${roomName}"`);
  }

  private async reconnect(): Promise<void> {
    if (this.destroyed) return;
    this.room = new Room();
    try {
      await this.connect(this.livekitUrl, this.apiKey, this.apiSecret, this.roomName);
    } catch (err) {
      console.error("[LivekitSubscriber] reconnect failed:", err);
      this.reconnectTimer = setTimeout(() => void this.reconnect(), 5000);
    }
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.room.disconnect();
  }
}

async function mintToken(apiKey: string, apiSecret: string, roomName: string): Promise<string> {
  const at = new AccessToken(apiKey, apiSecret, {
    identity: SUBSCRIBER_IDENTITY,
    name: "Voice Relay Bot Service",
    ttl: TOKEN_TTL,
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    canPublishData: false,
    roomRecord: false,
  });
  return at.toJwt();
}

/**
 * Convert an AudioFrame (mono or stereo, s16le) to a stereo Buffer.
 * @discordjs/voice StreamType.Raw requires stereo 48 kHz s16le.
 */
function toStereoPcm(frame: AudioFrame): Buffer {
  const numChannels = (frame as unknown as { numChannels?: number }).numChannels ?? frame.channels ?? 1;
  const data = frame.data as Int16Array;

  if (numChannels === 2) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  // Mono → stereo: interleave each sample with itself
  const stereo = new Int16Array(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    const s = data[i] ?? 0;
    stereo[i * 2] = s;
    stereo[i * 2 + 1] = s;
  }
  return Buffer.from(stereo.buffer);
}

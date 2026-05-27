export interface BotMetrics {
  name: string;
  channelId: string;
  voiceConnected: boolean;
  speaking: boolean;
  playerState: string;
  bufferBytes: number;
  bufferOverflows: number;       // lifetime total
  recentOverflows: number;       // since last watchdog tick (drained by watchdog)
  reconnectCount: number;
}

export interface ProcessMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}

export interface RelayMetrics {
  uptimeMs: number;
  framesReceived: number;
  bytesReceived: number;
  lastAudioAt: number | null;
  watchdogRestarts: number;
  process: ProcessMetrics;
  bots: BotMetrics[];
}

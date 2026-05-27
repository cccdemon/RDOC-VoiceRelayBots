import { loadConfig, type Config } from "./config.js";
import { BotManager } from "./discord/botManager.js";
import { LivekitSubscriber } from "./livekit/subscriber.js";
import type { RelayMetrics, ProcessMetrics } from "./metrics.js";
import { startAdminServer } from "./web/adminServer.js";

const CONFIG_PATH = process.env.CONFIG_PATH ?? "config.json";
const ADMIN_HOST = process.env.ADMIN_HOST ?? "0.0.0.0";
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? "8788");

// Fetch remote config from the RDOC-RTC bridge and merge it into local config.
async function applyBridgeConfig(cfg: Config): Promise<Config> {
  if (!cfg.bridge) return cfg;
  try {
    const res = await fetch(`${cfg.bridge.url}/relay-bots/service-config`, {
      headers: { Authorization: `Bearer ${cfg.bridge.serviceSecret}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[Bridge] service-config returned ${res.status} — using local config`);
      return cfg;
    }
    const remote = (await res.json()) as {
      livekitUrl: string;
      livekitApiKey: string;
      livekitApiSecret: string;
      roomName: string;
      guildId: string;
      bots: { name: string; token: string; channelId: string }[];
    };
    console.log(`[Bridge] loaded config from bridge (room=${remote.roomName}, bots=${remote.bots.length})`);
    return {
      ...cfg,
      livekit: {
        url: remote.livekitUrl || cfg.livekit.url,
        apiKey: remote.livekitApiKey || cfg.livekit.apiKey,
        apiSecret: remote.livekitApiSecret || cfg.livekit.apiSecret,
        relayRoomName: remote.roomName || cfg.livekit.relayRoomName,
      },
      discord: {
        guildId: remote.guildId || cfg.discord.guildId,
        bots: remote.bots.length > 0 ? remote.bots : cfg.discord.bots,
      },
    };
  } catch (err) {
    console.warn(`[Bridge] could not fetch service-config: ${String(err)} — using local config`);
    return cfg;
  }
}

let currentConfig: Config | null = null;
let currentStatus = "starting";
let bots: BotManager | null = null;
let subscriber: LivekitSubscriber | null = null;

const WATCHDOG_INTERVAL_MS = 10_000;
// Restart if more than this many buffer overflows happen in a single 10s tick
const OVERFLOW_RESTART_THRESHOLD = 5;
// Restart after all bots stay disconnected for this many consecutive ticks (10s each)
const DISCONNECT_RESTART_TICKS = 9; // ~90 s

// Global audio counters — reset on each relay start.
let relayStartedAt = Date.now();
let framesReceived = 0;
let bytesReceived = 0;
let lastAudioAt: number | null = null;
let watchdogRestarts = 0;
let consecutiveAllDisconnectedTicks = 0;

async function startRelay(cfg: Config): Promise<void> {
  currentStatus = "starting relay";
  const merged = await applyBridgeConfig(cfg);
  console.log(`[Startup] guild=${merged.discord.guildId} bots=${merged.discord.bots.length} room=${merged.livekit.relayRoomName}`);

  const nextBots = new BotManager();
  const nextSubscriber = new LivekitSubscriber((pcm) => {
    framesReceived++;
    bytesReceived += pcm.byteLength;
    lastAudioAt = Date.now();
    nextBots.pushPcm(pcm);
  });

  try {
    await nextBots.start(merged.discord.guildId, merged.discord.bots);
    await nextSubscriber.connect(
      merged.livekit.url,
      merged.livekit.apiKey,
      merged.livekit.apiSecret,
      merged.livekit.relayRoomName,
    );
  } catch (err) {
    await nextSubscriber.disconnect().catch(() => undefined);
    await nextBots.destroy().catch(() => undefined);
    currentStatus = "relay error";
    throw err;
  }

  bots = nextBots;
  subscriber = nextSubscriber;
  currentConfig = merged;
  currentStatus = "ready";
  relayStartedAt = Date.now();
  framesReceived = 0;
  bytesReceived = 0;
  lastAudioAt = null;
  console.log("[Ready] voice relay is active - waiting for audio");
}

async function stopRelay(): Promise<void> {
  currentStatus = "stopping relay";
  const oldSubscriber = subscriber;
  const oldBots = bots;
  subscriber = null;
  bots = null;
  await oldSubscriber?.disconnect();
  await oldBots?.destroy();
}

async function reloadRelay(cfg: Config): Promise<void> {
  await stopRelay();
  await startRelay(cfg);
}

function sampleProcessMetrics(): ProcessMetrics {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
  };
}

function getMetrics(): RelayMetrics {
  return {
    uptimeMs: Date.now() - relayStartedAt,
    framesReceived,
    bytesReceived,
    lastAudioAt,
    watchdogRestarts,
    process: sampleProcessMetrics(),
    bots: bots?.getMetrics() ?? [],
  };
}

function startWatchdog(): void {
  setInterval(() => {
    void (async () => {
      if (!bots || !currentConfig) return;

      const overflows = bots.drainRecentOverflows();
      if (overflows > OVERFLOW_RESTART_THRESHOLD) {
        console.warn(`[Watchdog] ${overflows} buffer overflows in tick — restarting relay`);
        watchdogRestarts++;
        consecutiveAllDisconnectedTicks = 0;
        await reloadRelay(currentConfig).catch((err) => console.error("[Watchdog] restart failed:", err));
        return;
      }

      const botMetrics = bots.getMetrics();
      const allDisconnected = botMetrics.length > 0 && botMetrics.every((b) => !b.voiceConnected);
      if (allDisconnected) {
        consecutiveAllDisconnectedTicks++;
        console.warn(`[Watchdog] all bots disconnected (${consecutiveAllDisconnectedTicks}/${DISCONNECT_RESTART_TICKS} ticks)`);
        if (consecutiveAllDisconnectedTicks >= DISCONNECT_RESTART_TICKS) {
          console.warn("[Watchdog] disconnect threshold reached — restarting relay");
          watchdogRestarts++;
          consecutiveAllDisconnectedTicks = 0;
          await reloadRelay(currentConfig).catch((err) => console.error("[Watchdog] restart failed:", err));
        }
      } else {
        consecutiveAllDisconnectedTicks = 0;
      }
    })();
  }, WATCHDOG_INTERVAL_MS);
}

async function main(): Promise<void> {
  startAdminServer({
    host: ADMIN_HOST,
    port: ADMIN_PORT,
    configPath: CONFIG_PATH,
    getConfig: () => currentConfig,
    getStatus: () => currentStatus,
    reload: reloadRelay,
    getBots: () => bots,
    getMetrics,
  });

  startWatchdog();

  try {
    await startRelay(loadConfig(CONFIG_PATH));
  } catch (err) {
    currentStatus = "config error";
    console.error("[Startup] relay did not start:", err);
    console.error("[Startup] fix the configuration in the web interface, then save and apply");
  }

  async function shutdown(signal: string): Promise<void> {
    console.log(`[Shutdown] ${signal}`);
    await stopRelay();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[Fatal]", err);
  process.exit(1);
});

import { loadConfig, type Config } from "./config.js";
import { BotManager } from "./discord/botManager.js";
import { LivekitSubscriber } from "./livekit/subscriber.js";
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

async function startRelay(cfg: Config): Promise<void> {
  currentStatus = "starting relay";
  const merged = await applyBridgeConfig(cfg);
  console.log(`[Startup] guild=${merged.discord.guildId} bots=${merged.discord.bots.length} room=${merged.livekit.relayRoomName}`);

  const nextBots = new BotManager();
  const nextSubscriber = new LivekitSubscriber((pcm) => nextBots.pushPcm(pcm));

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

async function main(): Promise<void> {
  startAdminServer({
    host: ADMIN_HOST,
    port: ADMIN_PORT,
    configPath: CONFIG_PATH,
    getConfig: () => currentConfig,
    getStatus: () => currentStatus,
    reload: reloadRelay,
    getBots: () => bots,
  });

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

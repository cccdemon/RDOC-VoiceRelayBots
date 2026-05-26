import { loadConfig, type Config } from "./config.js";
import { BotManager } from "./discord/botManager.js";
import { LivekitSubscriber } from "./livekit/subscriber.js";
import { startAdminServer } from "./web/adminServer.js";

const CONFIG_PATH = process.env.CONFIG_PATH ?? "config.json";
const ADMIN_HOST = process.env.ADMIN_HOST ?? "0.0.0.0";
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? "8788");

let currentConfig: Config | null = null;
let currentStatus = "starting";
let bots: BotManager | null = null;
let subscriber: LivekitSubscriber | null = null;

async function startRelay(cfg: Config): Promise<void> {
  currentStatus = "starting relay";
  console.log(`[Startup] guild=${cfg.discord.guildId} bots=${cfg.discord.bots.length} room=${cfg.livekit.relayRoomName}`);

  const nextBots = new BotManager();
  const nextSubscriber = new LivekitSubscriber((pcm) => nextBots.pushPcm(pcm));

  try {
    await nextBots.start(cfg.discord.guildId, cfg.discord.bots);
    await nextSubscriber.connect(
      cfg.livekit.url,
      cfg.livekit.apiKey,
      cfg.livekit.apiSecret,
      cfg.livekit.relayRoomName,
    );
  } catch (err) {
    await nextSubscriber.disconnect().catch(() => undefined);
    await nextBots.destroy().catch(() => undefined);
    currentStatus = "relay error";
    throw err;
  }

  bots = nextBots;
  subscriber = nextSubscriber;
  currentConfig = cfg;
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

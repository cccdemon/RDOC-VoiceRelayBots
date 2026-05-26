import { loadConfig } from "./config.js";
import { BotManager } from "./discord/botManager.js";
import { LivekitSubscriber } from "./livekit/subscriber.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log(`[Startup] guild=${cfg.discord.guildId} bots=${cfg.discord.bots.length} room=${cfg.livekit.relayRoomName}`);

  const bots = new BotManager();
  const subscriber = new LivekitSubscriber((pcm) => bots.pushPcm(pcm));

  // Start Discord bots first — they need a moment to connect before audio arrives
  await bots.start(cfg.discord.guildId, cfg.discord.bots);

  // Subscribe to the LiveKit relay room
  await subscriber.connect(
    cfg.livekit.url,
    cfg.livekit.apiKey,
    cfg.livekit.apiSecret,
    cfg.livekit.relayRoomName,
  );

  console.log("[Ready] voice relay is active — waiting for audio");

  async function shutdown(signal: string): Promise<void> {
    console.log(`[Shutdown] ${signal}`);
    await subscriber.disconnect();
    await bots.destroy();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[Fatal]", err);
  process.exit(1);
});

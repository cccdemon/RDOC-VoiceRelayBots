import type { BotConfig } from "../config.js";
import type { BotMetrics } from "../metrics.js";
import { RelayBot } from "./bot.js";

const STAGGER_MS = 600;

export class BotManager {
  private bots: RelayBot[] = [];

  async start(guildId: string, configs: BotConfig[]): Promise<void> {
    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i];
      if (!cfg) continue;
      if (i > 0) {
        // Stagger bot logins to avoid Discord rate-limiting simultaneous joins
        await new Promise<void>((r) => setTimeout(r, STAGGER_MS));
      }
      const bot = new RelayBot(cfg);
      this.bots.push(bot);
      await bot.start(guildId);
    }
    console.log(`[BotManager] ${this.bots.length} bot(s) ready`);
  }

  pushPcm(pcm: Buffer): void {
    for (const bot of this.bots) {
      bot.pushPcm(pcm);
    }
  }

  async destroy(): Promise<void> {
    await Promise.all(this.bots.map((b) => b.destroy()));
    this.bots = [];
  }

  getMetrics(): BotMetrics[] {
    return this.bots.map((b) => b.getMetrics());
  }

  drainRecentOverflows(): number {
    return this.bots.reduce((sum, b) => sum + b.drainRecentOverflows(), 0);
  }

  getVoiceStates(guildId: string): { channel_id: string | null; user_id: string; displayName: string }[] {
    const first = this.bots[0];
    if (!first) return [];
    return first.getVoiceStates(guildId);
  }
}

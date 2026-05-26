import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const BotConfigSchema = z.object({
  token: z.string().min(1),
  channelId: z.string().min(1),
  name: z.string().min(1),
});

export const ConfigSchema = z.object({
  livekit: z.object({
    url: z.string().url(),
    apiKey: z.string().min(1),
    apiSecret: z.string().min(1),
    relayRoomName: z.string().min(1).default("voice-relay"),
  }),
  discord: z.object({
    guildId: z.string().min(1),
    bots: z.array(BotConfigSchema).min(1),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;

export function loadConfig(path = "config.json"): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to read config file at "${path}": ${String(err)}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }
  return result.data;
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }
  return result.data;
}

export function saveConfig(config: Config, path = "config.json"): void {
  const parsed = parseConfig(config);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

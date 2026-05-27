# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**RDOC-VoiceRelayBots** — a relay service that bridges RDOC-RTC (LiveKit) audio into multiple Discord voice channels simultaneously. When a commander in the RDOC-RTC companion presses "Voice to All" PTT, the audio is published to a dedicated LiveKit relay room and relayed into N Discord voice channels via N bot accounts — one bot per channel.

Analogous to TeamSpeak's "Whisper to Channel" feature.

## Authorization model

The relay bots are **shared guild infrastructure** — one set of bots per Discord server, not per-Admiral. There are no per-Admiral bot assignments.

To activate "Voice to All", the requesting Admiral must:
1. Be a member of the configured Discord guild (`RELAY_GUILD_ID`)
2. Hold a specific configured role in that guild (`RELAY_REQUIRED_ROLE_ID`)

The bridge verifies this via the Discord API before minting a relay room token. Admins configure the guild ID and required role ID once in the bridge environment; individual Admirals either have the role or they don't.

## Data flow

```
[Companion: "Voice to All" PTT active]
          │ publishes mic track
          ▼
[LiveKit relay room: "voice-relay"]   ← fixed room, independent of sessions
          │ @livekit/rtc-node subscribes
          ▼
[RDOC-VoiceRelayBots service (Node.js)]
          │ fans out — one AudioPlayer per bot
  ┌───────┼────────┬─────────┐
  ▼       ▼        ▼         ▼
Bot 1   Bot 2   Bot 3  …  Bot N
  │       │        │         │
Chan1   Chan2   Chan3  …  ChanN
```

The relay room is decoupled from session rooms. The bot service stays connected 24/7; the companion activates relay on demand. Bot count is configurable via `config.json` — not hardcoded to 6.

## Project layout

```
RDOC-VoiceRelayBots/
├── src/
│   ├── index.ts             # startup, signal handling, graceful shutdown
│   ├── config.ts            # zod schema, loads config.json + env overrides
│   ├── livekit/
│   │   └── subscriber.ts    # Room, track subscribe, emits AudioFrames
│   ├── discord/
│   │   ├── botManager.ts    # create/destroy N BotClient instances
│   │   └── bot.ts           # single discord.js client + VoiceConnection + AudioPlayer
│   └── relay/
│       └── audioRelay.ts    # subscribe to LiveKit frames → write into per-bot streams
├── config.example.json
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Stack

- **Node.js 22 + TypeScript** — `tsx` for dev, compiled JS for prod
- **`@livekit/rtc-node`** — server-side LiveKit WebRTC subscriber (receives PCM `AudioFrame` objects)
- **`discord.js` + `@discordjs/voice`** — Discord client + voice channel connections
- **`@discordjs/opus`** — Opus codec; `@discordjs/voice` uses it to encode PCM → Opus for Discord
- **`zod`** — config validation

## Commands

```bash
npm install
npm run dev          # tsx watch src/index.ts
npm run build        # tsc
npm run start        # node dist/index.js
```

## Configuration

Config lives in `config.json` (gitignored). Template: `config.example.json`.

```json
{
  "livekit": {
    "url": "wss://voice.raumdock.org",
    "apiKey": "...",
    "apiSecret": "...",
    "relayRoomName": "voice-relay",
    "bridgeUrl": "https://voice.raumdock.org/dccc",
    "admiralKey": "...",
    "admiralSecret": "..."
  },
  "discord": {
    "guildId": "1234567890",
    "bots": [
      { "token": "BOT_TOKEN_1", "channelId": "111", "name": "Relay 1" },
      { "token": "BOT_TOKEN_2", "channelId": "222", "name": "Relay 2" }
    ]
  }
}
```

To add more bots: append entries to `bots[]`. No code changes needed.

## Audio pipeline

`@livekit/rtc-node` delivers decoded **PCM frames** (`AudioFrame`: s16le, 48 kHz, 1 ch). Discord expects Opus-encoded audio fed via `@discordjs/voice`.

```
LiveKit AudioFrame (PCM s16le 48 kHz)
  → per-bot PassThrough stream (Readable)
  → createAudioResource(stream, { inputType: StreamType.Raw })
  → AudioPlayer.play(resource)
  → VoiceConnection → Discord
```

Each bot gets its **own** `PassThrough` stream because `AudioResource` is single-use and cannot be shared. `audioRelay.ts` writes the same PCM chunk to all N streams on every `AudioFrame` event.

**Silence handling**: on PTT release, send 5 frames of silence then call `AudioPlayer.stop()`. This prevents Discord from showing the bot as permanently speaking. Use `NoSubscriberBehavior.Pause` so silence packets are sent when no one is listening.

## RDOC-RTC bridge additions required

One new route in `apps/bridge/src/routes/relay.ts`:

```
GET /relay/token?role=publisher|subscriber
  Auth: Admiral Basic key:secret
  Returns: { token: string, roomName: string, url: string }
  Errors: 403 if Admiral does not have RELAY_REQUIRED_ROLE_ID in RELAY_GUILD_ID
```

- `role=publisher` — for the companion (canPublish, !canSubscribe)
- `role=subscriber` — for the bot service (canSubscribe, !canPublish)
- Room name: `voice-relay` (single fixed room for the configured guild)

**Authorization check** (publisher only — bot service uses its own API credentials):
1. Resolve the Admiral's Discord user ID from their API credential record
2. `GET https://discord.com/api/v10/guilds/{RELAY_GUILD_ID}/members/{discordUserId}` using a bot token or the Discord OAuth token stored at login
3. Check `member.roles` contains `RELAY_REQUIRED_ROLE_ID`
4. Return 403 if not a member or role missing

New env vars in the bridge:
```
RELAY_GUILD_ID=            # Discord server ID where bots live
RELAY_REQUIRED_ROLE_ID=    # Role ID that grants relay access
RELAY_DISCORD_BOT_TOKEN=   # Any bot in the guild — used only for member lookups
```

Register the route in `apps/bridge/src/app.ts` alongside the other routes.

## RDOC-RTC companion additions required

"Voice to All" toggle button in the top bar:

1. First activation: fetch relay token (`GET /relay/token?role=publisher`), create a **second** `Room` instance for `voice-relay`, publish mic muted.
2. "Voice to All" PTT key (configurable, default `R`): `setMicrophoneEnabled(true/false)` on the relay room — independent from the session PTT.
3. Visual indicator on the button while relay PTT is held.
4. The relay `Room` is a separate instance from the session `Room`; both share the same mic input — LiveKit handles that natively.

## Docker

Standalone `docker-compose.yml` in this project. Can run on the same LXC as RDOC-RTC or standalone. Shares LiveKit by URL — no Docker network coupling needed.

```yaml
services:
  voice-relay-bots:
    build: .
    restart: unless-stopped
    volumes:
      - ./config.json:/app/config.json:ro
```

## Implementation phases

| Phase | Scope |
|---|---|
| 1 | Scaffold: TS + config loading + zod validation. `npm run dev` starts, reads config, exits cleanly. |
| 2 | Discord: N bots join voice channels on startup, send silence, reconnect on drop with exponential backoff. |
| 3 | LiveKit: subscribe to relay room, log frames received (no Discord relay yet). |
| 4 | Wire: PCM from LiveKit → per-bot PassThrough → AudioPlayer. Single-bot smoke test. |
| 5 | Scale: N bots in parallel. Silence padding on PTT release. |
| 6 | Bridge relay token endpoint + companion "Voice to All" button. End-to-end test. |
| 7 | Docker, update RDOC-RTC STAND.md, deploy. |

## Bridge integration (2026-05-27)

VoiceRelayBots can now pull its full config from the RDOC-RTC bridge admin at startup.
Set `bridge.url` and `bridge.serviceSecret` in `config.json`:

```json
{
  "bridge": {
    "url": "https://voice.raumdock.org/dccc",
    "serviceSecret": "RELAY_BOTS_SECRET_VALUE"
  },
  "livekit": { ... },  ← used as fallback only when bridge not reachable
  "discord": { ... }   ← used as fallback only
}
```

When bridge config is active, the bridge's `RelayBotsConfig` DB row overrides local `livekit`
and `discord` fields. Local config is the fallback if the bridge is unreachable.

The admin server exposes two new endpoints:
- `GET /api/voice-states` — returns guild voice states from the bot Gateway cache (consumed by bridge's Discord Voice page)
- `POST /api/reload` — triggered by bridge after a config save to restart the relay

The bridge's admin UI at `<bridge>/admin/ui/relay-bots` replaces the standalone admin at port 8788.
Both UIs remain functional; the bridge UI uses Discord OAuth, the standalone UI uses HTTP Basic.

## Open decisions (resolve before Phase 1)

- **Always-connected bots or connect on demand?** Recommendation: always connected (simplest; Discord does not penalize idle bots in voice).
- **Bot token storage** — plain `config.json` on the server (gitignored) is fine for a single-host deploy.
- **Web management UI** — not in scope for V1; can add a small Express status page later.
- **Which Discord bot token to use for member lookups?** One of the relay bot tokens works (any guild member bot can call the members API). Keep it as `RELAY_DISCORD_BOT_TOKEN` in the bridge env — separate from the relay service config.

## Quirks

- `@livekit/rtc-node` is a native Rust-backed Node.js addon; `npm install` pulls prebuilt binaries. Requires glibc 2.17+ (standard on any modern Debian/Ubuntu).
- Each Discord bot requires a separate application registered at discord.com/developers — one token per bot, one voice connection per token.
- Discord rate-limits bot joins: don't connect all N bots to voice simultaneously at startup; stagger by ~500 ms.
- `AudioResource` in `@discordjs/voice` is consumed when the player finishes or is stopped — create a fresh `PassThrough` + `createAudioResource` at the start of each PTT press, not once at startup.

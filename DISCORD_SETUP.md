# Discord Developer Setup — RDOC-VoiceRelayBots

How to register the N relay bots on [discord.com/developers/applications](https://discord.com/developers/applications) and invite them to your server. Repeat the steps in **sections 1–3** once per bot slot.

---

## Prerequisites

- A Discord account with **Manage Server** permission on the target guild
- Developer Mode enabled in Discord: *Settings → Advanced → Developer Mode* (needed to copy IDs)

## Authorization model

The relay bots are shared guild infrastructure. To use "Voice to All" an Admiral must:
- Be a **member** of the configured Discord guild
- Hold a specific **role** in that guild (e.g. `PTT-Relay` or any role you designate)

The RDOC-RTC bridge checks this via the Discord API before issuing a relay token. Configure the role in the bridge env as `RELAY_REQUIRED_ROLE_ID`. Assign it manually to any user who should have relay access.

---

## Section 1 — Create one application per bot slot

You need one Discord application per relay bot because a single bot token can only occupy one voice channel at a time.

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** (top-right)
3. Name it descriptively — e.g. `Relay Bot 1`, `Relay Bot 2`, … `Relay Bot 6`
4. Click **Create**

Repeat for each bot slot. You end up with N separate applications.

---

## Section 2 — Configure the bot user

Do the following for **each** application created above:

1. In the left sidebar click **Bot**
2. Click **Add Bot** → **Yes, do it!** (only shown the first time)
3. **Token**: click **Reset Token**, confirm, then **copy and save it** — this is `bots[i].token` in `config.json`. You cannot view it again after closing the dialog.
4. Under **Authorization Flow**:
   - Disable **Public Bot** — these bots should not be invitable by strangers
5. Under **Privileged Gateway Intents**:
   - **Server Members Intent** — OFF (not needed)
   - **Message Content Intent** — OFF (not needed)
   - **Presence Intent** — OFF (not needed)
   - **Guild Voice States** is NOT a privileged intent; no toggle needed

> `@discordjs/voice` requires `GatewayIntentBits.GuildVoiceStates`. This intent is non-privileged — no special approval from Discord is required regardless of server count.

---

## Section 3 — Invite the bot to your server

Still in the application, for **each** bot:

1. Left sidebar → **OAuth2 → URL Generator**
2. Under **Scopes** check: `bot`
3. Under **Bot Permissions** check:
   | Permission | Why |
   |---|---|
   | Connect | Join voice channels |
   | Speak | Send audio into the channel |
   | Use Voice Activity | Bot does not use PTT; this allows free speaking |
   | View Channel | See channels before joining |
4. Copy the generated URL at the bottom
5. Open it in a browser, select your guild, click **Authorize**
6. Repeat for each remaining bot application

All N bots now appear as members of your server.

---

## Section 4 — Create the relay access role

1. Open Discord → your server → **Server Settings → Roles**
2. Click **Create Role**, name it e.g. `PTT-Relay`
3. No special permissions needed — this role is only used as an authorization gate
4. Save the role
5. Right-click the role name → **Copy Role ID** — this is `RELAY_REQUIRED_ROLE_ID` in the bridge `.env`
6. Assign the role to any user who should be allowed to activate "Voice to All"

---

## Section 5 — Collect IDs for config.json

### Guild ID

1. Open Discord, right-click the **server icon** in the left rail
2. Click **Copy Server ID**
3. Paste into `config.json` → `discord.guildId`

### Voice Channel IDs

For each bot slot, decide which voice channel it should occupy permanently:

1. Right-click the target **voice channel**
2. Click **Copy Channel ID**
3. Paste into the matching `bots[i].channelId` entry in `config.json`

Each bot should point to a **different** voice channel. Two bots in the same channel provide no benefit.

---

## Section 6 — Fill in config.json and bridge .env

**VoiceRelayBots `config.json`:**

```json
{
  "livekit": {
    "url": "wss://voice.raumdock.org",
    "apiKey": "<livekit api key>",
    "apiSecret": "<livekit api secret>",
    "relayRoomName": "voice-relay",
    "bridgeUrl": "https://voice.raumdock.org/dccc",
    "admiralKey": "<rdoc-rtc admiral key>",
    "admiralSecret": "<rdoc-rtc admiral secret>"
  },
  "discord": {
    "guildId": "123456789012345678",
    "bots": [
      { "token": "MTI…bot1token…", "channelId": "111111111111111111", "name": "Relay 1" },
      { "token": "MTI…bot2token…", "channelId": "222222222222222222", "name": "Relay 2" },
      { "token": "MTI…bot3token…", "channelId": "333333333333333333", "name": "Relay 3" }
    ]
  }
}
```

`config.json` is gitignored. Never commit bot tokens.

**RDOC-RTC bridge `.env` additions:**

```env
RELAY_GUILD_ID=123456789012345678        # your Discord server ID
RELAY_REQUIRED_ROLE_ID=987654321098765   # the PTT-Relay role ID
RELAY_DISCORD_BOT_TOKEN=MTI...           # token of any one relay bot (used for member lookups)
```

---

## Section 7 — Verify bots are online

Start the service (`npm run dev` or `docker compose up`). In Discord you should see each bot:
- Appear as **online** in the member list
- Join its configured voice channel within a few seconds

If a bot stays offline, double-check:
- Token is correct (reset it again if uncertain — old tokens are immediately invalidated)
- The bot was actually invited to the guild (Section 3)
- `discord.guildId` matches the server where the bot was invited

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Used disallowed intents` error | You added a privileged intent in code that isn't enabled in the portal. Check the bot page. |
| Bot appears offline | Token is wrong or was regenerated. Reset token in portal and update config.json. |
| Bot joins channel then immediately leaves | Missing `Connect` or `Speak` permission on that specific channel. Check channel permission overrides. |
| Bot is online but not in the channel | Channel ID is wrong, or the channel is in a different guild than `guildId`. |
| `Missing Access` error in logs | Bot was not invited to the server, or the channel is in a category the bot cannot see. |

---

## Adding relay access for a user

1. Open Discord → Server Settings → Members
2. Find the user, assign the `PTT-Relay` role (or whatever role `RELAY_REQUIRED_ROLE_ID` points to)
3. No restart or config change needed — the bridge checks the role live on each token request

## Adding more bots later

1. Create another application (Section 1), configure it (Section 2), invite it (Section 3)
2. Get its token and the target channel ID
3. Append a new entry to `bots[]` in `config.json`
4. Restart the service — no code change needed

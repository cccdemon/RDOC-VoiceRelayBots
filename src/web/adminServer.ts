import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import type { Config } from "../config.js";
import { parseConfig, saveConfig } from "../config.js";
import type { BotManager } from "../discord/botManager.js";

type AdminServerOptions = {
  host: string;
  port: number;
  configPath: string;
  getConfig: () => Config | null;
  getStatus: () => string;
  reload: (config: Config) => Promise<void>;
  getBots: () => BotManager | null;
};

const MAX_BODY_BYTES = 256 * 1024;

export function startAdminServer(options: AdminServerOptions): void {
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!password) {
    console.warn("[Admin] ADMIN_PASSWORD is not set; web interface is unauthenticated");
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, options, password).catch((err) => {
      sendJson(res, 500, { error: "internal_error", message: String(err) });
    });
  });

  server.listen(options.port, options.host, () => {
    console.log(`[Admin] listening on http://${options.host}:${options.port}`);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: AdminServerOptions,
  password: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (password && !isAuthorized(req, password)) {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="RDOC Voice Relay Bots"',
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, renderAdminPage());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      status: options.getStatus(),
      config: options.getConfig(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await readJsonBody(req);
    const config = parseConfig(body);
    saveConfig(config, options.configPath);
    await options.reload(config);
    sendJson(res, 200, { ok: true, status: options.getStatus(), config });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/restart") {
    const config = options.getConfig();
    if (!config) {
      sendJson(res, 400, { error: "no_valid_config" });
      return;
    }
    await options.reload(config);
    sendJson(res, 200, { ok: true, status: options.getStatus() });
    return;
  }

  // POST /api/reload — triggered by the bridge after a config save
  if (req.method === "POST" && url.pathname === "/api/reload") {
    const config = options.getConfig();
    if (config) {
      void options.reload(config).catch(() => undefined);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/voice-states — returns guild voice state data from the bot Gateway cache
  if (req.method === "GET" && url.pathname === "/api/voice-states") {
    const cfg = options.getConfig();
    const bots = options.getBots();
    if (!bots || !cfg) {
      sendJson(res, 200, []);
      return;
    }
    const states = bots.getVoiceStates(cfg.discord.guildId);
    sendJson(res, 200, states);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function isAuthorized(req: IncomingMessage, password: string): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf-8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return user === "admin" && pass === password;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RDOC Voice Relay Bots</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, sans-serif; background: #15171d; color: #f4f7fb; }
    body { margin: 0; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 22px; }
    h1 { font-size: 24px; margin: 0; }
    h2 { font-size: 16px; margin: 0 0 12px; color: #cbd5e1; }
    .status { padding: 7px 10px; border: 1px solid #334155; border-radius: 6px; color: #93c5fd; }
    section { border-top: 1px solid #2b3140; padding: 20px 0; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .bot { display: grid; grid-template-columns: 1fr 1fr 2fr auto; gap: 10px; align-items: end; padding: 12px; border: 1px solid #2b3140; border-radius: 6px; margin-bottom: 10px; background: #1b1f2a; }
    label { display: grid; gap: 6px; color: #94a3b8; font-size: 12px; }
    input { box-sizing: border-box; width: 100%; background: #0f131b; color: #f8fafc; border: 1px solid #3b4254; border-radius: 5px; padding: 9px 10px; font-size: 14px; }
    button { background: #2563eb; color: white; border: 0; border-radius: 5px; padding: 10px 13px; font-weight: 650; cursor: pointer; }
    button.secondary { background: #334155; }
    button.danger { background: #b91c1c; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
    .error { color: #fecaca; white-space: pre-wrap; }
    .hint { color: #94a3b8; font-size: 13px; margin-top: 8px; }
    @media (max-width: 850px) { .grid, .bot { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>RDOC Voice Relay Bots</h1>
      <div class="status" id="status">loading</div>
    </header>

    <section>
      <h2>LiveKit</h2>
      <div class="grid">
        <label>URL <input id="livekitUrl" /></label>
        <label>Relay Room <input id="relayRoomName" /></label>
        <label>API Key <input id="apiKey" /></label>
        <label>API Secret <input id="apiSecret" type="password" /></label>
      </div>
    </section>

    <section>
      <h2>Discord</h2>
      <label>Guild ID <input id="guildId" /></label>
      <div class="hint">Bot name is used as the server nickname. The bot needs "Change Nickname" permission.</div>
    </section>

    <section>
      <h2>Bots</h2>
      <div id="bots"></div>
      <button class="secondary" id="addBot">Add Bot</button>
    </section>

    <div class="error" id="error"></div>
    <div class="actions">
      <button class="secondary" id="reload">Reload</button>
      <button class="secondary" id="restart">Restart Relay</button>
      <button id="save">Save and Apply</button>
    </div>
  </main>

  <script>
    let config = null;
    const $ = (id) => document.getElementById(id);

    function botTemplate(bot, index) {
      const div = document.createElement("div");
      div.className = "bot";
      div.innerHTML = \`
        <label>Name <input data-field="name" value="\${escapeAttr(bot.name || "")}" /></label>
        <label>Channel ID <input data-field="channelId" value="\${escapeAttr(bot.channelId || "")}" /></label>
        <label>Token <input data-field="token" type="password" value="\${escapeAttr(bot.token || "")}" /></label>
        <button class="danger" type="button">Remove</button>
      \`;
      div.querySelector("button").addEventListener("click", () => {
        config.discord.bots.splice(index, 1);
        render();
      });
      div.querySelectorAll("input").forEach((input) => {
        input.addEventListener("input", () => {
          config.discord.bots[index][input.dataset.field] = input.value;
        });
      });
      return div;
    }

    function escapeAttr(value) {
      return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    }

    function render() {
      $("livekitUrl").value = config.livekit.url || "";
      $("relayRoomName").value = config.livekit.relayRoomName || "";
      $("apiKey").value = config.livekit.apiKey || "";
      $("apiSecret").value = config.livekit.apiSecret || "";
      $("guildId").value = config.discord.guildId || "";
      const bots = $("bots");
      bots.innerHTML = "";
      config.discord.bots.forEach((bot, index) => bots.appendChild(botTemplate(bot, index)));
    }

    function readForm() {
      config.livekit.url = $("livekitUrl").value.trim();
      config.livekit.relayRoomName = $("relayRoomName").value.trim();
      config.livekit.apiKey = $("apiKey").value.trim();
      config.livekit.apiSecret = $("apiSecret").value;
      config.discord.guildId = $("guildId").value.trim();
      return config;
    }

    async function load() {
      $("error").textContent = "";
      const res = await fetch("api/config");
      const data = await res.json();
      $("status").textContent = data.status || "unknown";
      if (!data.config) {
        $("error").textContent = "No valid config loaded. Save a complete config to start the relay.";
        config = { livekit: { url: "", apiKey: "", apiSecret: "", relayRoomName: "relay-one" }, discord: { guildId: "", bots: [] } };
      } else {
        config = data.config;
      }
      render();
    }

    async function save() {
      $("error").textContent = "";
      const res = await fetch("api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(readForm()),
      });
      const data = await res.json();
      if (!res.ok) {
        $("error").textContent = data.message || JSON.stringify(data);
        return;
      }
      config = data.config;
      $("status").textContent = data.status || "saved";
      render();
    }

    $("addBot").addEventListener("click", () => {
      config.discord.bots.push({ name: "Funker", channelId: "", token: "" });
      render();
    });
    $("reload").addEventListener("click", load);
    $("save").addEventListener("click", save);
    $("restart").addEventListener("click", async () => {
      $("error").textContent = "";
      const res = await fetch("api/restart", { method: "POST" });
      const data = await res.json();
      if (!res.ok) $("error").textContent = data.message || JSON.stringify(data);
      $("status").textContent = data.status || "restarted";
    });
    load().catch((err) => $("error").textContent = String(err));
  </script>
</body>
</html>`;
}

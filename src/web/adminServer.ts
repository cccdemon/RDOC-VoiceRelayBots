import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import type { Config } from "../config.js";
import { parseConfig, saveConfig } from "../config.js";
import type { BotManager } from "../discord/botManager.js";
import type { RelayMetrics } from "../metrics.js";

type AdminServerOptions = {
  host: string;
  port: number;
  configPath: string;
  getConfig: () => Config | null;
  getStatus: () => string;
  reload: (config: Config) => Promise<void>;
  getBots: () => BotManager | null;
  getMetrics: () => RelayMetrics;
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

  // Prometheus scraper hits /metrics without auth — port is internal-only
  if (req.method === "GET" && url.pathname === "/metrics") {
    sendPrometheus(res, options.getMetrics());
    return;
  }

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

  if (req.method === "GET" && url.pathname === "/api/metrics") {
    sendJson(res, 200, options.getMetrics());
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

function sendPrometheus(res: ServerResponse, m: RelayMetrics): void {
  const lines: string[] = [];

  function metric(
    name: string,
    help: string,
    type: "gauge" | "counter",
    values: Array<{ labels?: Record<string, string>; value: number }>,
  ): void {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const { labels, value } of values) {
      const lab = labels
        ? "{" +
          Object.entries(labels)
            .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
            .join(",") +
          "}"
        : "";
      lines.push(`${name}${lab} ${value}`);
    }
  }

  metric("relay_uptime_seconds", "Relay uptime in seconds", "gauge", [{ value: m.uptimeMs / 1000 }]);
  metric("relay_frames_received_total", "PCM frames received from LiveKit since relay start", "counter", [{ value: m.framesReceived }]);
  metric("relay_bytes_received_total", "PCM bytes received from LiveKit since relay start", "counter", [{ value: m.bytesReceived }]);
  metric("relay_last_audio_timestamp_seconds", "Unix timestamp of last audio frame (0 = none)", "gauge", [{ value: m.lastAudioAt ? m.lastAudioAt / 1000 : 0 }]);
  metric("relay_watchdog_restarts_total", "Watchdog-triggered relay restarts", "counter", [{ value: m.watchdogRestarts }]);
  metric("relay_process_rss_bytes", "Process RSS memory in bytes", "gauge", [{ value: m.process.rssBytes }]);
  metric("relay_process_heap_used_bytes", "V8 heap used in bytes", "gauge", [{ value: m.process.heapUsedBytes }]);
  metric("relay_process_heap_total_bytes", "V8 heap total in bytes", "gauge", [{ value: m.process.heapTotalBytes }]);
  metric("relay_bot_voice_connected", "Bot has active voice connection (1=yes)", "gauge",
    m.bots.map((b) => ({ labels: { bot: b.name }, value: b.voiceConnected ? 1 : 0 })));
  metric("relay_bot_speaking", "Bot is currently playing audio (1=yes)", "gauge",
    m.bots.map((b) => ({ labels: { bot: b.name }, value: b.speaking ? 1 : 0 })));
  metric("relay_bot_buffer_bytes", "PassThrough write-buffer backlog in bytes", "gauge",
    m.bots.map((b) => ({ labels: { bot: b.name }, value: b.bufferBytes })));
  metric("relay_bot_buffer_overflows_total", "Total buffer overflow drop events", "counter",
    m.bots.map((b) => ({ labels: { bot: b.name }, value: b.bufferOverflows })));
  metric("relay_bot_reconnect_count_total", "Total voice channel reconnection events", "counter",
    m.bots.map((b) => ({ labels: { bot: b.name }, value: b.reconnectCount })));

  res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  res.end(lines.join("\n") + "\n");
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
    /* metrics */
    .m-chips { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
    .m-chip { background: #1b1f2a; border: 1px solid #2b3140; border-radius: 6px; padding: 8px 14px; min-width: 100px; }
    .m-chip .lbl { color: #64748b; font-size: 11px; margin-bottom: 3px; }
    .m-chip .val { font-size: 15px; font-weight: 600; }
    .m-bots { display: flex; flex-direction: column; gap: 8px; }
    .m-bot { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid #2b3140; border-radius: 6px; background: #1b1f2a; }
    .m-bot-name { font-weight: 600; min-width: 130px; }
    .m-state { font-size: 11px; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .s-playing  { background: #14532d; color: #86efac; }
    .s-idle     { background: #1e293b; color: #94a3b8; }
    .s-autopaused { background: #1e293b; color: #475569; }
    .s-buffering { background: #78350f; color: #fcd34d; }
    .m-conn { font-size: 11px; color: #64748b; white-space: nowrap; }
    .m-buf-wrap { flex: 1; min-width: 80px; }
    .m-buf-lbl { font-size: 11px; color: #64748b; margin-bottom: 3px; }
    .m-buf-track { height: 5px; background: #0f131b; border-radius: 3px; overflow: hidden; }
    .m-buf-fill { height: 100%; border-radius: 3px; transition: width 0.4s, background 0.4s; }
    .buf-ok   { background: #22c55e; }
    .buf-warn { background: #f59e0b; }
    .buf-crit { background: #ef4444; }
    .m-overflow { font-size: 11px; color: #f87171; white-space: nowrap; }
    .m-reconnect { font-size: 11px; color: #94a3b8; white-space: nowrap; }
    .m-chip.warn .val { color: #f87171; }
    @media (max-width: 850px) { .grid, .bot { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } .m-bot { flex-wrap: wrap; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>RDOC Voice Relay Bots</h1>
      <div class="status" id="status">loading</div>
    </header>

    <section>
      <h2>Live Metrics <span style="font-size:11px;color:#475569">· auto-refresh 2 s</span></h2>
      <div class="m-chips" id="m-global"></div>
      <div class="m-bots" id="m-bots"></div>
    </section>

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

    // ── Config form ──────────────────────────────────────────────────────────

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

    // ── Metrics ──────────────────────────────────────────────────────────────

    // 1 second of stereo s16le — must match MAX_BUFFER_BYTES in bot.ts
    const MAX_BUF = 48_000 * 2 * 2 * 1;

    function fmtDuration(ms) {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return h + "h " + (m % 60) + "m";
      if (m > 0) return m + "m " + (s % 60) + "s";
      return s + "s";
    }

    function fmtBytes(b) {
      if (b < 1024) return b + " B";
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
      return (b / 1024 / 1024).toFixed(1) + " MB";
    }

    function chip(label, value, warn) {
      return '<div class="m-chip' + (warn ? ' warn' : '') + '"><div class="lbl">' + label + '</div><div class="val">' + value + '</div></div>';
    }

    async function loadMetrics() {
      const res = await fetch("api/metrics").catch(() => null);
      if (!res || !res.ok) return;
      const m = await res.json();

      const lastAudio = m.lastAudioAt
        ? Math.round((Date.now() - m.lastAudioAt) / 1000) + " s ago"
        : "—";

      const p = m.process || {};
      $("m-global").innerHTML =
        chip("Uptime", fmtDuration(m.uptimeMs)) +
        chip("Frames in", m.framesReceived.toLocaleString()) +
        chip("Audio in", fmtBytes(m.bytesReceived)) +
        chip("Last audio", lastAudio) +
        chip("Watchdog restarts", m.watchdogRestarts, m.watchdogRestarts > 0) +
        chip("RSS", fmtBytes(p.rssBytes || 0)) +
        chip("Heap used", fmtBytes(p.heapUsedBytes || 0));

      $("m-bots").innerHTML = m.bots.map((b) => {
        const pct = Math.min(100, (b.bufferBytes / MAX_BUF) * 100);
        const fillCls = pct < 40 ? "buf-ok" : pct < 75 ? "buf-warn" : "buf-crit";
        const stateCls = b.playerState === "playing" ? "s-playing"
          : b.playerState === "buffering" ? "s-buffering"
          : b.playerState === "autopaused" ? "s-autopaused"
          : "s-idle";
        const connLabel = b.voiceConnected
          ? (b.speaking ? "🔊 speaking" : "🔇 in channel")
          : "⭕ not connected";
        const overflowHtml = b.bufferOverflows > 0
          ? '<span class="m-overflow">⚠ ' + b.bufferOverflows + ' overflow' + (b.bufferOverflows > 1 ? "s" : "") + '</span>'
          : "";
        const reconnectHtml = b.reconnectCount > 0
          ? '<span class="m-reconnect">↻ ' + b.reconnectCount + ' reconnect' + (b.reconnectCount > 1 ? "s" : "") + '</span>'
          : "";
        return [
          '<div class="m-bot">',
          '  <span class="m-bot-name">' + b.name + '</span>',
          '  <span class="m-state ' + stateCls + '">' + b.playerState + '</span>',
          '  <span class="m-conn">' + connLabel + '</span>',
          '  <div class="m-buf-wrap">',
          '    <div class="m-buf-lbl">Buffer ' + fmtBytes(b.bufferBytes) + ' / ' + fmtBytes(MAX_BUF) + '</div>',
          '    <div class="m-buf-track"><div class="m-buf-fill ' + fillCls + '" style="width:' + pct.toFixed(1) + '%"></div></div>',
          '  </div>',
          reconnectHtml,
          overflowHtml,
          '</div>',
        ].join("");
      }).join("");
    }

    loadMetrics().catch(() => null);
    setInterval(() => loadMetrics().catch(() => null), 2000);
  </script>
</body>
</html>`;
}

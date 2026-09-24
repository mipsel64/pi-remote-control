import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

function configFiles() {
  const server = process.env.RC_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'prc', 'config.json');
  return { server, client: path.join(path.dirname(server), 'client.json') };
}

function checkLegacyConfig() {
  if (process.env.RC_CONFIG !== undefined) return;
  const { server } = configFiles();
  const exists = (file: string) => {
    try { fs.lstatSync(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  if (exists(server)) return;
  const oldDir = path.join(path.dirname(path.dirname(server)), 'pi-remote-control');
  if (exists(path.join(oldDir, 'config.json')) || exists(path.join(oldDir, 'client.json')))
    throw new Error(`Legacy private config found in ${oldDir}. Move config.json and client.json (if present) to ${path.dirname(server)} manually without overwriting files; keep mode 0600. Do not run setup until migrated.`);
}

function readPrivateConfig(file: string): Record<string, unknown> {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Cannot read private remote-control config');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('Remote-control config must be a regular file with mode 0600');
    const config: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid remote-control config');
    return config as Record<string, unknown>;
  } catch { throw new Error('Invalid private remote-control config'); }
  finally { fs.closeSync(fd); }
}

function agentUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid remote-control URL');
  const endpoint = new URL(value);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.pathname !== '/agent' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      (endpoint.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('Invalid remote-control URL');
  return endpoint.href;
}

function connectionSettings(): { url?: string; token?: string; urlSource: string; tokenSource: string } {
  const overrideUrl = process.env.PI_RC_URL;
  const overrideToken = process.env.PI_RC_AGENT_TOKEN;
  if (overrideUrl !== undefined || overrideToken !== undefined) {
    if (!overrideUrl || !overrideToken) throw new Error('Set both PI_RC_URL and PI_RC_AGENT_TOKEN, or neither');
    return { url: agentUrl(overrideUrl), token: overrideToken, urlSource: 'PI_RC_URL', tokenSource: 'PI_RC_AGENT_TOKEN' };
  }

  checkLegacyConfig();
  const { server, client } = configFiles();
  const config = readPrivateConfig(server);
  const local = readPrivateConfig(client);
  const origin = config.publicOrigin;
  let derivedUrl: string | undefined;
  if (typeof origin === 'string') {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid remote-control origin');
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '/agent';
    derivedUrl = parsed.href;
  }
  const url = local.url === undefined ? derivedUrl : local.url;
  const token = local.token === undefined ? config.agentToken : local.token;
  if (token !== undefined && (typeof token !== 'string' || !token)) throw new Error('Invalid private remote-control config');
  return { url: url === undefined ? undefined : agentUrl(url), token: token as string | undefined,
    urlSource: local.url === undefined ? 'server config' : 'client.json',
    tokenSource: local.token === undefined ? 'server config' : 'client.json' };
}

type Model = NonNullable<ExtensionContext['model']>;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// Mirrors pi-ai getSupportedThinkingLevels without importing pi-ai at runtime.
function thinkingLevels(model: Model) {
  if (!model.reasoning) return ['off'];
  return THINKING_LEVELS.filter(level => {
    const mapped = (model.thinkingLevelMap as Record<string, unknown> | undefined)?.[level];
    return mapped !== null && (level !== 'xhigh' && level !== 'max' || mapped !== undefined);
  });
}

function advertisedModels(current: ExtensionContext) {
  const models = current.scopedModels.length ? current.scopedModels.map(scoped => scoped.model) : current.modelRegistry.getAvailable();
  const seen = new Set<string>();
  return models.filter(model => {
    const key = `${model.provider}\0${model.id}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

const modelList = (current: ExtensionContext) =>
  advertisedModels(current).map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning: Boolean(reasoning) }));

function saveClientUrl(url: string) {
  const { client } = configFiles();
  const existing = readPrivateConfig(client);
  const dir = path.dirname(client);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.client-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...existing, url }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, client);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export default function remoteControl(pi: ExtensionAPI) {
  // One remote entry per Pi session; the map outlives runtimes so /reload keeps the same entry.
  const processState = globalThis as typeof globalThis & { __piRemoteControlEntryIds?: Map<string, string> };
  const entryIds = processState.__piRemoteControlEntryIds ??= new Map<string, string>();
  function entryId(current: ExtensionContext) {
    const sessionId = current.sessionManager.getSessionId();
    let id = entryIds.get(sessionId);
    if (!id) entryIds.set(sessionId, id = randomUUID());
    return id;
  }
  let ctx: ExtensionContext | undefined;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let settings: ReturnType<typeof connectionSettings> | undefined;
  let failed = false;
  // Announce only the connection a /rc command opens; automatic reconnects stay silent.
  let announce = false;
  let lastTitle = '';

  function title(current: ExtensionContext, pending?: { role?: string; content?: unknown }) {
    const name = pi.getSessionName();
    if (name) return name;
    const first = current.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message?.role === 'user');
    const content = first?.type === 'message' ? first.message.content : pending?.role === 'user' ? pending.content : undefined;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join(' ') : '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Pi';
  }

  function status(current: ExtensionContext, state: 'connected' | 'connecting' | 'retrying' | 'off') {
    const color = state === 'connected' ? 'success' : state === 'retrying' ? 'warning' : 'dim';
    current.ui.setStatus('rc', state === 'off' ? undefined : current.ui.theme.fg(color, `/rc ${state}`));
  }

  function connectionState() {
    return !ctx ? 'off' : socket?.readyState === WebSocket.OPEN ? 'connected' : failed ? 'retrying' : 'connecting';
  }

  function stop() {
    if (ctx) status(ctx, 'off');
    ctx = undefined;
    failed = false;
    announce = false;
    lastTitle = '';
    settings = undefined;
    if (retry) clearTimeout(retry);
    retry = undefined;
    const ws = socket;
    socket = undefined;
    ws?.close();
  }

  pi.registerCommand('rc', {
    description: 'Attach this Pi session to remote control (/rc setup, /rc status, /rc close)',
    handler: async (args, current) => {
      const action = args.trim();
      if (action === 'setup') {
        const client = configFiles().client;
        try {
          const overrides = process.env.PI_RC_URL !== undefined || process.env.PI_RC_AGENT_TOKEN !== undefined;
          if (overrides && (!process.env.PI_RC_URL || !process.env.PI_RC_AGENT_TOKEN)) {
            current.ui.notify('Partial PI_RC_* override: set both PI_RC_URL and PI_RC_AGENT_TOKEN or unset both; /rc setup cannot edit environment overrides', 'warning');
            return;
          }
          const effective = connectionSettings();
          const state = connectionState();
          current.ui.notify(`Endpoint: ${effective.url ?? '(none)'} (${effective.urlSource}); token: ${effective.token ? '[redacted]' : '(missing)'} (${effective.tokenSource}); state: ${state}`, 'info');
          if (overrides) {
            current.ui.notify('PI_RC_URL and PI_RC_AGENT_TOKEN override local config; unset both before editing with /rc setup', 'warning');
            return;
          }
          current.ui.notify(`Client config: ${client}. To change the token, edit this mode-0600 file outside Pi ("token" field); /rc setup never displays or prompts for a token.`, 'info');
          if (!current.hasUI) return;
          const proposed = await current.ui.input('Agent URL (ws://loopback/agent or wss://host/agent); cancel to keep', effective.url);
          if (proposed === undefined || !proposed.trim()) return;
          saveClientUrl(agentUrl(proposed.trim()));
          current.ui.notify('Client URL saved; use /rc close then /rc to reconnect with it', 'info');
        } catch (error) {
          current.ui.notify(error instanceof Error && error.message.startsWith('Legacy private config found') ? error.message : 'Remote control setup invalid or could not save private client config; check URL, config permissions, and PI_RC_* overrides', 'error');
        }
        return;
      }
      if (action === 'status') {
        current.ui.notify(`Remote control ${connectionState()}${failed ? '; retrying — check the server, URL, and agent token' : ''}`, failed ? 'warning' : 'info');
        return;
      }
      if (action === 'close') {
        stop();
        current.ui.notify('Remote control closed', 'info');
        return;
      }
      if (action) {
        current.ui.notify('Use /rc, /rc setup, /rc status, or /rc close', 'warning');
        return;
      }
      try {
        settings = connectionSettings();
        if (!settings.url || !settings.token) {
          stop();
          current.ui.notify('Remote control not configured; run prc setup on this host or set both PI_RC_URL and PI_RC_AGENT_TOKEN', 'warning');
          return;
        }
        ctx = current;
        status(current, connectionState() === 'retrying' ? 'retrying' : 'connecting');
        if (socket?.readyState === WebSocket.OPEN) {
          hello(current);
          status(current, 'connected');
        } else {
          announce = true;
          connect();
        }
      } catch (error) {
        stop();
        current.ui.notify(error instanceof Error && error.message.startsWith('Legacy private config found') ? error.message : 'Remote control configuration invalid; check private config or both PI_RC_URL and PI_RC_AGENT_TOKEN', 'error');
      }
    },
  });

  function send(message: object) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function snapshot(current: ExtensionContext) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const sessionId = current.sessionManager.getSessionId();
    const entries = current.sessionManager.getBranch();
    const data = JSON.stringify(entries);
    const chunkSize = 128 * 1024;
    if (data.length <= chunkSize) {
      send({ type: 'snapshot', processId: entryId(current), sessionId, entries });
      return;
    }
    const snapshotId = randomUUID();
    const total = Math.ceil(data.length / chunkSize);
    for (let index = 0; index < total; index++) {
      send({ type: 'snapshot_chunk', processId: entryId(current), sessionId, snapshotId, index, total,
        data: data.slice(index * chunkSize, (index + 1) * chunkSize) });
    }
  }

  function hello(current: ExtensionContext, pending?: { role?: string; content?: unknown }) {
    sendHello(current, pending);
    snapshot(current);
  }

  function sendHello(current: ExtensionContext, pending?: { role?: string; content?: unknown }) {
    const entries = current.sessionManager.getBranch();
    const updatedAt = entries.reduce((latest, entry) => entry.type === 'message' && entry.message && ['user', 'assistant'].includes(entry.message.role)
      ? Math.max(latest, Date.parse(entry.timestamp) || 0) : latest, 0);
    lastTitle = title(current, pending);
    const model = current.model;
    send({ type: 'hello', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), name: lastTitle, cwd: current.cwd, busy: !current.isIdle(), updatedAt,
      model: model ? { provider: model.provider, id: model.id, name: model.name, reasoning: Boolean(model.reasoning), thinkingLevels: thinkingLevels(model) } : null,
      thinkingLevel: pi.getThinkingLevel(),
      models: modelList(current) });
  }

  function connect() {
    if (!ctx || socket || !settings?.url || !settings.token) return;
    const ws = new WebSocket(settings.url, { headers: { Authorization: `Bearer ${settings.token}` } });
    socket = ws;
    ws.on('open', () => {
      if (socket !== ws || !ctx) return;
      delay = 1000;
      failed = false;
      hello(ctx);
      status(ctx, 'connected');
      if (announce) ctx.ui.notify('Remote control connected', 'info');
      announce = false;
    });
    ws.on('message', raw => {
      if (socket !== ws || !ctx) return;
      let command: { type?: unknown; sessionId?: unknown; text?: unknown; provider?: unknown; modelId?: unknown; level?: unknown; name?: unknown };
      try { command = JSON.parse(raw.toString()); } catch { return; }
      const current = ctx;
      if (!command || typeof command !== 'object' || command.sessionId !== current.sessionManager.getSessionId()) return;
      if (command.type === 'history') snapshot(current);
      else if (command.type === 'models') send({ type: 'models', processId: entryId(current), sessionId: command.sessionId, models: modelList(current) });
      else if (command.type === 'prompt' && typeof command.text === 'string' && command.text.trim() && Buffer.byteLength(command.text) <= 16 * 1024) {
        pi.sendUserMessage(command.text, current.isIdle() ? undefined : { deliverAs: 'followUp' });
      } else if (command.type === 'abort' && !current.isIdle()) current.abort();
      else if (command.type === 'set_model' && typeof command.provider === 'string' && typeof command.modelId === 'string') {
        const model = current.modelRegistry.find(command.provider, command.modelId);
        if (!model || !advertisedModels(current).some(item => item.provider === model.provider && item.id === model.id)) return;
        const warn = () => current.ui.notify(`Remote control could not switch to ${model.provider}/${model.id}; check that provider's auth`, 'warning');
        pi.setModel(model).then(ok => { if (!ok) warn(); }, warn);
      } else if (command.type === 'set_thinking' && THINKING_LEVELS.includes(command.level as never))
        pi.setThinkingLevel(command.level as typeof THINKING_LEVELS[number]);
      else if (command.type === 'rename' && typeof command.name === 'string' && command.name.length <= 1024) pi.setSessionName(command.name.trim());
    });
    // Connection errors close the socket; the close handler retries.
    ws.on('error', () => {});
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = undefined;
      announce = false;
      if (ctx) {
        status(ctx, 'retrying');
        if (!failed) ctx.ui.notify('Remote control connection failed; retrying. Check the server, URL, and agent token', 'warning');
        failed = true;
        retry = setTimeout(() => { retry = undefined; connect(); }, delay);
        delay = Math.min(delay * 2, 30000);
      }
    });
  }

  pi.on('session_start', (_event, current) => {
    if (!ctx) return;
    ctx = current;
    if (socket?.readyState === WebSocket.OPEN) {
      hello(current);
      status(current, 'connected');
    } else {
      status(current, failed ? 'retrying' : 'connecting');
      connect();
    }
  });
  pi.on('session_info_changed', (_event, current) => {
    if (socket?.readyState === WebSocket.OPEN) hello(current);
  });
  for (const type of ['model_select', 'thinking_level_select'] as const) {
    pi.on(type, (_event, current) => {
      if (ctx && socket?.readyState === WebSocket.OPEN) sendHello(current);
    });
  }
  pi.on('session_tree', (_event, current) => snapshot(current));
  for (const type of ['message_start', 'message_update', 'message_end', 'agent_start', 'agent_settled'] as const) {
    pi.on(type, (event, current) => {
      if (ctx && type === 'message_end' && socket?.readyState === WebSocket.OPEN && 'message' in event && title(current, event.message) !== lastTitle)
        hello(current, event.message);
      send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event });
    });
  }
  pi.on('session_shutdown', stop);
}

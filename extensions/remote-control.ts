import { execFileSync } from 'node:child_process';
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
  const models = current.scopedModels?.length ? current.scopedModels.map(scoped => scoped.model) : current.modelRegistry.getAvailable();
  const seen = new Set<string>();
  return models.filter(model => {
    const key = `${model.provider}\0${model.id}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

const modelList = (current: ExtensionContext) =>
  advertisedModels(current).map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning: Boolean(reasoning) }));

// Null outside a repo or on a detached HEAD.
function gitBranch(cwd: string) {
  try { return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

// The host's own gauge (Pi and omp count differently); tokens is null while unknown, e.g. right after compaction.
function contextUsage(current: ExtensionContext) {
  try {
    const usage = current.getContextUsage?.();
    if (!usage || !(usage.contextWindow > 0)) return null;
    return { tokens: typeof usage.tokens === 'number' ? Math.round(usage.tokens) : null, contextWindow: Math.round(usage.contextWindow) };
  } catch { return null; }
}

// Server cap is 256 UTF-16 units; cut on code points so a surrogate pair is never split.
function preview(text: string, max = 200) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = '';
  for (const char of flat) {
    if (cut.length + char.length > max - 1) break;
    cut += char;
  }
  return `${cut}…`;
}

type Fields = Record<string, unknown>;
type Background = { kind: 'shell' | 'agent'; id: string; label: string; detail: string; full?: string; startedAt: number | null };
// Servers before 0.1.6 drop a `detail` over 256 units, so the longer form travels in its own field, sent only when `detail` was cut.
function describe(text: string) {
  const detail = preview(text);
  const full = preview(text, 1000);
  return full === detail ? { detail } : { detail, full };
}
const MAX_BACKGROUND = 20;
const LIVE_PROCESS_STATUSES = ['running', 'terminating', 'terminate_timeout'];
const startTime = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;

// pi-processes `processes:request:list` rows; its protocol is internal to that package, so validate every field.
function shellItems(list: unknown): Background[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((row: Fields) => {
    if (!row || typeof row.id !== 'string' || !row.id || typeof row.command !== 'string' || !LIVE_PROCESS_STATUSES.includes(row.status as string)) return [];
    const name = typeof row.name === 'string' && row.name.trim() ? row.name : row.command;
    return [{ kind: 'shell' as const, id: row.id, label: preview(name, 80), ...describe(row.command), startedAt: startTime(row.startTime) }];
  });
}

// pi-subagents RPC `status` reply; `data.fleet` v1 is its documented display DTO.
function agentItems(reply: unknown): Background[] {
  const fleet = (reply as Fields)?.success === true ? ((reply as { data?: Fields }).data?.fleet as Fields | undefined) : undefined;
  if (fleet?.version !== 1 || !Array.isArray(fleet.entries)) return [];
  return fleet.entries.flatMap((entry: Fields) => {
    if (!entry || typeof entry.key !== 'string' || !entry.key || typeof entry.agent !== 'string' || !entry.agent.trim()) return [];
    const label = typeof entry.role === 'string' && entry.role ? `${entry.agent} · ${entry.role}` : entry.agent;
    const detail = [entry.goal, entry.model].filter(part => typeof part === 'string' && part).join(' · ');
    return [{ kind: 'agent' as const, id: entry.key, label: preview(label, 80), ...describe(detail), startedAt: startTime(entry.startedAt) }];
  });
}

// Notification text for the final reply: its closing question, else its opening paragraph.
// ponytail: "ends with ?" is the whole question heuristic; misses "let me know…" phrasing.
function lastReply(entries: ReturnType<ExtensionContext['sessionManager']['getBranch']>) {
  const last = entries.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant');
  const content = last?.type === 'message' ? last.message.content : undefined;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n\n') : '';
  const paragraphs = text.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/).map(paragraph => paragraph
    .replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/gm, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const closing = paragraphs.at(-1) ?? '';
  const asking = closing.endsWith('?');
  const summary = asking ? closing : paragraphs[0] ?? '';
  return { asking, summary: summary.length > 160 ? `${summary.slice(0, 159)}…` : summary };
}

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
  let lastBranch: string | null = null;
  // Tracked while disconnected too, so a reconnect during an open dialog still reports it.
  let waiting = false;
  let asking = false;
  // Held here instead of Pi's queue, which extensions cannot edit, so later prompts join the waiting one.
  // Kept across /rc close: the run still settles and delivers it.
  let queued: string[] = [];
  let stopped = false;
  let runSignal: AbortSignal | undefined;
  const previews = () => queued.map(text => preview(text));
  // Filled from other extensions' pi.events protocols; a list stays empty when its extension is not loaded.
  let shells: Background[] = [];
  let agents: Background[] = [];
  let sentBackground = '[]';
  let agentsRequest: string | undefined;
  let agentsStale = false;
  // Each kind keeps half the slots when both overflow, so many shells never hide every subagent.
  const background = () => {
    const agentSlots = Math.min(agents.length, Math.max(MAX_BACKGROUND / 2, MAX_BACKGROUND - shells.length));
    return [...shells.slice(0, MAX_BACKGROUND - agentSlots), ...agents.slice(0, agentSlots)];
  };
  function publishBackground() {
    const list = background();
    const json = JSON.stringify(list);
    if (!ctx || json === sentBackground) return;
    sentBackground = json;
    send({ type: 'event', processId: entryId(ctx), sessionId: ctx.sessionManager.getSessionId(), event: { type: 'background_update', background: list } });
  }
  function refreshShells() {
    let list: unknown;
    // pi-processes answers synchronously inside emit.
    pi.events?.emit('processes:request:list', { reply: (processes: unknown) => { list = processes; } });
    shells = shellItems(list);
  }
  // One request in flight; changes that arrive meanwhile trigger one more.
  function refreshAgents() {
    if (!pi.events) return;
    if (agentsRequest) {
      agentsStale = true;
      return;
    }
    const requestId = randomUUID();
    agentsRequest = requestId;
    const done = (reply?: unknown) => {
      if (agentsRequest !== requestId) return;
      agentsRequest = undefined;
      off();
      clearTimeout(timer);
      if (reply !== undefined || agents.length) {
        // A timeout means pi-subagents stopped answering, so its last list is no longer true.
        agents = reply === undefined ? [] : agentItems(reply);
        publishBackground();
      }
      if (agentsStale) {
        agentsStale = false;
        refreshAgents();
      }
    };
    const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, done);
    // No reply means pi-subagents is not loaded.
    const timer = setTimeout(done, 5000);
    timer.unref?.();
    pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'status' });
  }
  function setQueued(current: ExtensionContext, next: string[]) {
    if (!queued.length && !next.length) return;
    queued = next;
    send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event: { type: 'queue_update', queued: previews() } });
  }
  function sendQueued(current: ExtensionContext, texts = queued) {
    setQueued(current, []);
    // followUp is ignored while Pi is idle, and still queues safely if another prompt started first.
    pi.sendUserMessage(texts.join('\n\n'), { deliverAs: 'followUp' });
  }
  // Mirrors Pi's own Stop, which puts queued messages back in the terminal editor.
  function restoreQueued(current: ExtensionContext) {
    const text = queued.join('\n\n');
    setQueued(current, []);
    current.ui.setEditorText([text, current.ui.getEditorText()].filter(part => part.trim()).join('\n\n'));
  }

  function title(current: ExtensionContext, pending?: { role?: string; content?: unknown }) {
    const name = pi.getSessionName();
    if (name) return name;
    const first = current.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message?.role === 'user');
    const content = first?.type === 'message' ? first.message.content : pending?.role === 'user' ? pending.content : undefined;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join(' ') : '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New Session';
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
    refreshShells();
    refreshAgents();
    sendHello(current, pending);
    snapshot(current);
  }

  function sendHello(current: ExtensionContext, pending?: { role?: string; content?: unknown }) {
    const entries = current.sessionManager.getBranch();
    const updatedAt = entries.reduce((latest, entry) => entry.type === 'message' && entry.message && ['user', 'assistant'].includes(entry.message.role)
      ? Math.max(latest, Date.parse(entry.timestamp) || 0) : latest, 0);
    lastTitle = title(current, pending);
    lastBranch = gitBranch(current.cwd);
    const model = current.model;
    const list = background();
    sentBackground = JSON.stringify(list);
    send({ type: 'hello', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), name: lastTitle, cwd: current.cwd, host: os.hostname().split('.')[0], branch: lastBranch, busy: !current.isIdle(), waiting, asking, updatedAt,
      model: model ? { provider: model.provider, id: model.id, name: model.name, reasoning: Boolean(model.reasoning), thinkingLevels: thinkingLevels(model) } : null,
      context: contextUsage(current),
      queued: previews(),
      background: list,
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
        const texts = [...queued, command.text];
        if (current.isIdle()) sendQueued(current, texts);
        else setQueued(current, texts);
      } else if (command.type === 'abort' && !current.isIdle()) {
        stopped = true;
        current.abort();
      } else if (command.type === 'set_model' && typeof command.provider === 'string' && typeof command.modelId === 'string') {
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
    if (queued.length) restoreQueued(current);
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
  for (const type of ['message_start', 'message_update', 'message_end', 'agent_start', 'agent_settled', 'ui_prompt_start', 'ui_prompt_end'] as const) {
    pi.on(type, (event, current) => {
      if (type === 'ui_prompt_start' || type === 'ui_prompt_end') waiting = type === 'ui_prompt_start';
      if (type === 'agent_start') asking = false;
      // Per low-level run, so keep the latest; it also catches a Stop pressed during a tool call.
      if (type === 'agent_start' || type === 'message_start') runSignal = current.signal ?? runSignal;
      const usage = type === 'message_end' || type === 'agent_settled' ? contextUsage(current) : null;
      let payload: object = usage ? { ...event, contextUsage: usage } : event;
      if (type === 'agent_settled') {
        const reply = lastReply(current.sessionManager.getBranch());
        asking = reply.asking;
        payload = { ...payload, asking, ...(reply.summary ? { summary: reply.summary } : {}) };
      }
      if (ctx && type === 'message_end' && socket?.readyState === WebSocket.OPEN && 'message' in event && title(current, event.message) !== lastTitle)
        hello(current, event.message);
      // Tools may switch branches during a run.
      if (ctx && type === 'agent_settled' && socket?.readyState === WebSocket.OPEN && gitBranch(current.cwd) !== lastBranch) sendHello(current);
      send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event: payload });
      if (type === 'agent_settled') {
        // A Stop skips agent_before_settle; otherwise the prompt arrived after it, and Pi defers a prompt sent now past settling.
        if (queued.length && (stopped || runSignal?.aborted)) restoreQueued(current);
        else if (queued.length) sendQueued(current);
        stopped = false;
        runSignal = undefined;
      }
    });
  }
  // Awaited while Pi is still streaming, so a follow-up queued here continues this run natively.
  // ponytail: a slow Pi input handler can still submit it after a Stop pressed meanwhile, as with any extension prompt.
  pi.on('agent_before_settle', async (event, current) => {
    if (!queued.length || event.outcome === 'aborted' || stopped) return;
    sendQueued(current);
    // sendUserMessage queues asynchronously (input handlers first); Pi checks its queue once this resolves.
    for (let tries = 0; tries < 100 && !current.hasPendingMessages(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
  });
  // A manual /compact is not an agent run; Pi goes idle right after this event, so deliver on the next tick.
  for (const type of ['session_compact', 'session_compact_failed'] as const) {
    pi.on(type, (_event, current) => {
      setTimeout(() => {
        try { if (queued.length && current.isIdle()) sendQueued(current); }
        catch { /* The runtime was replaced (/reload, /new) before the tick. */ }
      }, 0);
    });
  }
  pi.on('session_shutdown', stop);
  // Optional chaining: hosts without pi.events (older Pi, omp) just never show background work.
  pi.events?.on('processes:changed', () => {
    if (!ctx) return;
    refreshShells();
    publishBackground();
  });
  for (const channel of ['subagents:rpc:v1:ready', 'subagent:async-started', 'subagent:async-complete', 'subagent:child-status', 'subagent:foreground-complete'])
    pi.events?.on(channel, () => { if (ctx) refreshAgents(); });
}

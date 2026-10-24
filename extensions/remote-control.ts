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
// How often a non-idle omp run without its final agent_end is rechecked.
const IDLE_POLL_MS = 100;

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
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  let cut = '';
  for (const char of text) {
    if (cut.length + char.length > max - 1) break;
    cut += char;
  }
  return `${cut}…`;
}
function preview(text: string, max = 200) {
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}

type Fields = Record<string, unknown>;
const record = (value: unknown) => value && typeof value === 'object' ? value as Fields : undefined;
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
// omp has no job change events: jobs settle and are evicted silently, so running items are re-pulled this often.
const OMP_POLL_MS = 2000;
const OMP_ENDED = ['completed', 'failed', 'aborted'];
const trimmed = (value: unknown) => typeof value === 'string' ? value.trim() : '';

// One omp `task:subagent:lifecycle` or `task:subagent:progress` frame for subagent `id`; progress frames nest the live state under `progress`.
function ompSubagentItem(id: string, frame: Fields, startedAt: number | null): Background {
  const progress = record(frame.progress) ?? frame;
  const type = trimmed(frame.agent) || trimmed(progress.agent);
  const assignment = trimmed(frame.assignment) || trimmed(progress.assignment);
  const activity = [progress.currentToolIntent, progress.lastIntent, progress.description, frame.description].map(trimmed).find(Boolean)
    || assignment.split('\n').map(line => line.trim()).find(Boolean) || '';
  const detail = preview(activity);
  const full = preview(assignment, 1000);
  return { kind: 'agent', id, label: preview(type && type !== 'task' ? `${id} · ${type}` : id, 80), detail, ...(full && full !== detail ? { full } : {}), startedAt };
}
// omp sets ctx.agent.kind ('main' or 'sub'); Pi has no such field and only runs main sessions.
function isMainSession(current: ExtensionContext) {
  const kind = (current as unknown as { agent?: { kind?: unknown } }).agent?.kind;
  return kind === undefined || kind === 'main';
}

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

const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'abandoned', 'blocked'];
type Todo = { id: string; content: string; status: string; phase?: string; blocker?: string };

type TodoPhase = { name: string; tasks: { content: string; status: string; blocker?: unknown }[] };

// omp's todo tool reports its whole plan as `details.phases`.
function todoPhases(value: unknown) {
  const valid = Array.isArray(value) && value.every(phase => typeof phase?.name === 'string' && Array.isArray(phase.tasks)
    && phase.tasks.every(task => typeof task?.content === 'string' && TODO_STATUSES.includes(task.status)));
  return valid ? value as TodoPhase[] : undefined;
}

// The server drops items past its text caps, so cut to them.
function flattenTodos(phases: TodoPhase[]): Todo[] {
  return phases.flatMap((phase, i) => phase.tasks.flatMap((task, j) => {
    const content = preview(task.content, 1024);
    if (!content) return [];
    const group = preview(phase.name, 256);
    const blocker = typeof task.blocker === 'string' ? preview(task.blocker, 1024) : '';
    return [{ id: `${i}.${j}`, content, status: task.status, ...(group ? { phase: group } : {}), ...(blocker ? { blocker } : {}) }];
  }));
}

// Latest durable plan on the branch: a successful todo result or the user's own edit. Views and errors never change it.
function branchTodos(entries: unknown[]): Todo[] {
  for (const entry of entries.toReversed()) {
    const item = record(entry);
    const message = record(item?.message);
    const details = record(message?.details);
    const edit = item?.type === 'custom' && item.customType === 'user_todo_edit' ? record(item.data) : undefined;
    const result = item?.type === 'message' && message?.role === 'toolResult' && message.toolName === 'todo' && !message.isError && details?.op !== 'view' ? details : undefined;
    const phases = todoPhases((edit ?? result)?.phases);
    if (phases) return flattenTodos(phases);
  }
  return [];
}

const MAX_ASK_QUESTIONS = 20;
const MAX_ASK_OPTIONS = 50;
const MAX_ASK_INPUT = 16 * 1024;
type AskQuestion = { id: string; question: string; header?: string; options: { label: string; description?: string }[]; multi?: boolean; recommended?: number };
type AskAnswer = { selectedOptions: string[]; customInput?: string };
type AskResult = AskAnswer & { id: string; question: string; options: string[]; multi: boolean };
type AskEntry = { requestId: string; questions: AskQuestion[]; local: AbortController; answers?: AskAnswer[]; answered: Promise<void>; resolve: () => void };
type InvokeTool = (params: Fields, options?: { signal?: AbortSignal; onUpdate?: unknown }) => Promise<unknown>;

// Only asks a browser can answer exactly are offered: the server drops one it cannot hold, and answers must match ids and labels verbatim.
function askQuestions(params: unknown) {
  const list = record(params)?.questions;
  if (!Array.isArray(list) || !list.length || list.length > MAX_ASK_QUESTIONS) return undefined;
  const questions: AskQuestion[] = [];
  for (const raw of list as Fields[]) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 256 || typeof raw.question !== 'string' || !raw.question.trim()
      || !Array.isArray(raw.options) || raw.options.length > MAX_ASK_OPTIONS || questions.some(question => question.id === raw.id)) return undefined;
    const options: AskQuestion['options'] = [];
    for (const option of raw.options as Fields[]) {
      if (!option || typeof option.label !== 'string' || !option.label || option.label.length > 256 || options.some(known => known.label === option.label)) return undefined;
      const description = typeof option.description === 'string' ? option.description.trim() : '';
      options.push({ label: option.label, ...(description ? { description } : {}) });
    }
    const header = typeof raw.header === 'string' ? raw.header.trim() : '';
    questions.push({ id: raw.id, question: raw.question, ...(header ? { header } : {}), options,
      ...(typeof raw.multi === 'boolean' ? { multi: raw.multi } : {}), ...(typeof raw.recommended === 'number' ? { recommended: raw.recommended } : {}) });
  }
  return questions;
}

function askPrompt(entry: AskEntry | undefined) {
  if (!entry) return null;
  return { requestId: entry.requestId, questions: entry.questions.map(question => ({ id: question.id, question: clip(question.question, 1024),
    ...(question.header ? { header: clip(question.header, 256) } : {}),
    options: question.options.map(option => ({ label: option.label, ...(option.description ? { description: clip(option.description, 1024) } : {}) })),
    ...(question.multi !== undefined ? { multi: question.multi } : {}),
    ...(question.recommended !== undefined && Number.isInteger(question.recommended) && question.recommended >= 0 && question.recommended < question.options.length ? { recommended: question.recommended } : {}) })) };
}

// One answer per question, in order. Unanswered questions record no selection, like a question the terminal user skipped.
function askAnswers(questions: AskQuestion[], given: unknown) {
  if (!Array.isArray(given) || !given.length || given.length > questions.length) return undefined;
  const answers = new Map<string, AskAnswer>();
  for (const item of given as Fields[]) {
    const question = questions.find(candidate => candidate.id === item?.id);
    if (!question || answers.has(question.id)) return undefined;
    const { selectedOptions, customInput } = item;
    if (!Array.isArray(selectedOptions) || selectedOptions.length > (question.multi ? question.options.length : 1)
      || !selectedOptions.every((label, index) => typeof label === 'string' && question.options.some(option => option.label === label) && selectedOptions.indexOf(label) === index)) return undefined;
    if (customInput != null && (typeof customInput !== 'string' || Buffer.byteLength(customInput) > MAX_ASK_INPUT)) return undefined;
    const custom = typeof customInput === 'string' && customInput.trim() ? customInput.replace(/\r\n?/g, '\n') : undefined;
    if (!question.multi && !selectedOptions.length && custom === undefined) return undefined;
    answers.set(question.id, { selectedOptions, ...(custom !== undefined ? { customInput: custom } : {}) });
  }
  return questions.map(question => answers.get(question.id) ?? { selectedOptions: [] });
}

// Same result text and details the native ask tool produces for a dialog answer, so the model cannot tell the surfaces apart.
function askResult(questions: AskQuestion[], answers: AskAnswer[]) {
  const results: AskResult[] = questions.map((question, index) => ({ id: question.id, question: question.question,
    options: question.options.map(option => option.label), multi: question.multi ?? false, ...answers[index] }));
  if (results.length > 1) return { content: [{ type: 'text', text: `User answers:\n${results.map(answerLine).join('\n')}` }], details: { results } };
  const [result] = results;
  const parts: string[] = [];
  if (result.selectedOptions.length) parts.push(`User selected: ${result.multi ? result.selectedOptions.join(', ') : result.selectedOptions[0]}`);
  if (result.customInput !== undefined)
    parts.push(result.customInput.includes('\n') ? `User provided custom input:\n${result.customInput.split('\n').map(line => `  ${line}`).join('\n')}` : `User provided custom input: ${result.customInput}`);
  const text = parts.length ? parts.join('\n') : result.multi ? 'User did not select any options' : 'User cancelled the selection';
  return { content: [{ type: 'text', text }],
    details: { question: result.question, options: result.options, multi: result.multi, selectedOptions: result.selectedOptions, customInput: result.customInput } };
}

function answerLine(result: AskResult) {
  const custom = result.customInput === undefined ? undefined : `"${result.customInput}"`;
  if (!result.selectedOptions.length) return custom !== undefined ? `${result.id}: ${custom}` : result.multi ? `${result.id}: []` : `${result.id}: (cancelled)`;
  const picked = result.multi ? `[${result.selectedOptions.join(', ')}]` : result.selectedOptions[0];
  return `${result.id}: ${custom === undefined ? picked : `${picked} + ${custom}`}`;
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
  // processId of the socket's first hello; the server binds the connection to it.
  let socketProcessId: string | undefined;
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
  // Track runs separately from isIdle(), which is also false during compaction; omp reconciles stale runs when idle returns.
  let running = false;
  let runGeneration = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Pi rejects prompts during manual compaction; only hold them between active runs.
  // Kept across /rc close: the run still settles and delivers it.
  let queued: string[] = [];
  // Display only: Pi owns delivery. Each record is one native message, including joined held prompts.
  let pending: { text: string; observedPending: boolean }[] = [];
  let pendingTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let runSignal: AbortSignal | undefined;
  const previews = () => [...pending.map(item => item.text), ...queued].map(text => preview(text));
  // Filled from Pi extensions' pi.events protocols (a list stays empty when its extension is not loaded), or from omp's own subagents and jobs.
  let shells: Background[] = [];
  let agents: Background[] = [];
  let sentBackground = '[]';
  let agentsRequest: string | undefined;
  let agentsStale = false;
  // omp uses final agent_end as settlement and injects schema builders into its extension API.
  const omp = 'arktype' in pi;
  // omp re-runs this factory in every subagent session; only the main session tracks and publishes background work.
  let mainSession = false;
  // Live depth-1 omp subagents by id (an async task job shares it); ended ids drop late progress frames until revived.
  const ompSubagents = new Map<string, Background>();
  const ompEnded = new Set<string>();
  let ompTimer: ReturnType<typeof setInterval> | undefined;
  // The agent's plan, flattened from omp todo results; sent in hello and whenever it changes.
  let todos: Todo[] = [];
  let sentTodos = '[]';
  // The one open omp ask a browser can answer. The local dialog stays live; the first answer wins.
  let pendingAsk: AskEntry | undefined;
  let askRegistered = false;
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
  function stopOmpTimer() {
    clearInterval(ompTimer);
    ompTimer = undefined;
  }
  function clearOmp() {
    stopOmpTimer();
    ompSubagents.clear();
    ompEnded.clear();
  }
  // Main-owned running jobs: bash jobs are shells; task jobs merge with the subagent frames by id; eval jobs are not shown.
  function collectOmp(current: ExtensionContext) {
    let snapshot: Fields | undefined;
    try { snapshot = record((current as unknown as { getAsyncJobSnapshot?: () => unknown }).getAsyncJobSnapshot?.()); }
    catch { /* The runtime was replaced (/reload, /new) before this pull. */ }
    const jobs = Array.isArray(snapshot?.running) ? snapshot.running.map(record) : [];
    const taskJobs = new Map<string, Fields>();
    shells = [];
    for (const job of jobs) {
      const id = trimmed(job?.id);
      if (!job || !id) continue;
      // omp suffixes a revived subagent's job id (`Probe-2`) and vibe turns (`Probe-t3`); agentId is the subagent's own id.
      if (job.type === 'task') taskJobs.set(trimmed(job.agentId) || id, job);
      if (job.type !== 'bash') continue;
      const command = trimmed(job.command);
      const label = trimmed(job.label) || command;
      if (label) shells.push({ kind: 'shell', id, label: preview(label, 80), ...describe(command || label), startedAt: startTime(job.startTime) });
    }
    agents = [...ompSubagents.values()].map(item => ({ ...item, startedAt: startTime(taskJobs.get(item.id)?.startTime) ?? item.startedAt }));
    for (const [id, job] of taskJobs)
      if (!ompSubagents.has(id)) agents.push({ kind: 'agent', id, label: preview(trimmed(job.label) || id, 80), detail: '', startedAt: startTime(job.startTime) });
    if (!shells.length && !agents.length) stopOmpTimer();
    else if (!ompTimer) {
      ompTimer = setInterval(refreshOmp, OMP_POLL_MS);
      ompTimer.unref?.();
    }
  }
  function refreshOmp() {
    if (!ctx || !mainSession) return stopOmpTimer();
    collectOmp(ctx);
    publishBackground();
  }
  function publishQueue(current: ExtensionContext) {
    send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event: { type: 'queue_update', queued: previews() } });
    if (!pending.length && pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = undefined;
    }
  }
  function clearPending(current: ExtensionContext) {
    if (!pending.length) return;
    pending = [];
    publishQueue(current);
  }
  function trackPending(current: ExtensionContext, text: string) {
    pending.push({ text, observedPending: false });
    publishQueue(current);
    if (pendingTimer) return;
    // Public API exposes only a boolean; clear/requeue between polls or unrelated
    // native input needs a Pi queue-observation API for exact reconciliation.
    pendingTimer = setInterval(() => {
      try {
        if (current.hasPendingMessages()) {
          for (const item of pending) item.observedPending = true;
        } else {
          const next = pending.filter(item => !item.observedPending);
          if (next.length !== pending.length) {
            pending = next;
            publishQueue(current);
          }
        }
      } catch {
        // A replaced context cannot publish a queue update.
        pending = [];
        clearInterval(pendingTimer);
        pendingTimer = undefined;
      }
    }, 250);
    pendingTimer.unref?.();
  }
  function setQueued(current: ExtensionContext, next: string[]) {
    if (!queued.length && !next.length) return;
    queued = next;
    publishQueue(current);
  }
  function sendQueued(current: ExtensionContext, texts = queued) {
    const text = texts.join('\n\n');
    const hadHeld = queued.length > 0;
    queued = [];
    // Idle input starts a conversation, not a native queue (and may be handled without a run).
    if (current.isIdle()) {
      if (hadHeld) publishQueue(current);
    } else {
      // Register before sendUserMessage: input handlers and native consumption can be asynchronous.
      trackPending(current, text);
    }
    pi.sendUserMessage(text, { deliverAs: 'steer' });
  }
  // Mirrors Pi's own Stop, which puts queued messages back in the terminal editor.
  function restoreQueued(current: ExtensionContext) {
    const text = queued.join('\n\n');
    setQueued(current, []);
    current.ui.setEditorText([text, current.ui.getEditorText()].filter(part => part.trim()).join('\n\n'));
  }

  function publishTodos(current: ExtensionContext) {
    const json = JSON.stringify(todos);
    if (!ctx || json === sentTodos) return;
    sentTodos = json;
    send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event: { type: 'todo_update', todos } });
  }

  function publishAsk(current: ExtensionContext) {
    send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event: { type: 'ask_update', ask: askPrompt(pendingAsk) } });
  }
  // Dismisses the local dialog too; callers that cannot publish (a replaced context) rely on the hello that follows.
  function cancelAsk(current?: ExtensionContext) {
    const entry = pendingAsk;
    if (!entry) return;
    pendingAsk = undefined;
    entry.local.abort();
    if (current) publishAsk(current);
  }
  function answerAsk(current: ExtensionContext, command: { requestId?: unknown; answers?: unknown }) {
    const entry = pendingAsk;
    if (!entry || command.requestId !== entry.requestId) return;
    const answers = askAnswers(entry.questions, command.answers);
    if (!answers) return;
    entry.answers = answers;
    pendingAsk = undefined;
    entry.resolve();
    entry.local.abort();
    publishAsk(current);
  }
  async function askExecute(_toolCallId: string, params: Fields, signal: AbortSignal | undefined, onUpdate: unknown, toolCtx: ExtensionContext & { invokeTool?: InvokeTool }) {
    if (!toolCtx.invokeTool) throw new Error('Ask tool requires interactive mode');
    const questions = pendingAsk ? undefined : askQuestions(params);
    if (!questions) return toolCtx.invokeTool(params, { signal, onUpdate });
    const { promise: answered, resolve } = Promise.withResolvers<void>();
    const entry: AskEntry = { requestId: randomUUID(), questions, local: new AbortController(), answered, resolve };
    pendingAsk = entry;
    if (ctx) publishAsk(ctx);
    try {
      // The native tool owns the dialog, timeout and result; aborting `local` makes it throw, which a browser answer then discards.
      const dialog = toolCtx.invokeTool(params, { signal: signal ? AbortSignal.any([signal, entry.local.signal]) : entry.local.signal, onUpdate });
      const result = await Promise.race([dialog, answered]);
      return entry.answers ? askResult(questions, entry.answers) : result;
    } catch (error) {
      if (entry.answers) return askResult(questions, entry.answers);
      throw error;
    } finally {
      if (pendingAsk === entry) {
        pendingAsk = undefined;
        if (ctx) publishAsk(ctx);
      }
    }
  }
  // omp's ask dialog has no passive hook, so re-register over the native tool only after /rc opts in.
  function registerAsk() {
    if (!omp || askRegistered) return;
    const native = pi.getAllTools().find(tool => tool.name === 'ask' && tool.sourceInfo?.source === 'builtin');
    if (!native) return;
    askRegistered = true;
    // Preserve every metadata/example/render field the host exposes; only execution needs to change.
    pi.registerTool({ label: 'Ask', approval: 'read', strict: true, concurrency: 'exclusive', loadMode: 'discoverable',
      ...native, execute: askExecute } as never);
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
    dropSocket();
    stopOmpTimer();
  }

  // Closes the current socket without the close handler's retry or warning.
  function dropSocket() {
    const ws = socket;
    socket = undefined;
    socketProcessId = undefined;
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
        mainSession = isMainSession(current);
        registerAsk();
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

  function send(message: Record<string, unknown>) {
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
    if (!omp) {
      refreshShells();
      refreshAgents();
    } else if (mainSession) collectOmp(current);
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
    sentTodos = JSON.stringify(todos);
    socketProcessId = entryId(current);
    send({ type: 'hello', processId: socketProcessId, sessionId: current.sessionManager.getSessionId(), name: lastTitle, cwd: current.cwd, host: os.hostname().split('.')[0], branch: lastBranch, busy: running && (!omp || !current.isIdle()), waiting, asking, updatedAt,
      model: model ? { provider: model.provider, id: model.id, name: model.name, reasoning: Boolean(model.reasoning), thinkingLevels: thinkingLevels(model) } : null,
      context: contextUsage(current),
      queued: previews(),
      background: list,
      todos,
      ask: askPrompt(pendingAsk),
      thinkingLevel: pi.getThinkingLevel(),
      models: modelList(current) });
  }

  function connect() {
    if (!ctx || socket || !settings?.url || !settings.token) return;
    const ws = new WebSocket(settings.url, { headers: { Authorization: `Bearer ${settings.token}` } });
    socket = ws;
    socketProcessId = undefined;
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
      let command: { type?: unknown; sessionId?: unknown; text?: unknown; provider?: unknown; modelId?: unknown; level?: unknown; name?: unknown; requestId?: unknown; answers?: unknown };
      try { command = JSON.parse(raw.toString()); } catch { return; }
      const current = ctx;
      if (!command || typeof command !== 'object' || command.sessionId !== current.sessionManager.getSessionId()) return;
      if (command.type === 'history') snapshot(current);
      else if (command.type === 'models') send({ type: 'models', processId: entryId(current), sessionId: command.sessionId, models: modelList(current) });
      else if (command.type === 'prompt' && typeof command.text === 'string' && command.text.trim() && Buffer.byteLength(command.text) <= 16 * 1024) {
        const texts = [...queued, command.text];
        if (!stopped && (current.isIdle() || current.signal?.aborted === false)) sendQueued(current, texts);
        else setQueued(current, texts);
      } else if (command.type === 'abort' && !current.isIdle()) {
        stopped = true;
        clearPending(current);
        current.abort();
      } else if (command.type === 'set_model' && typeof command.provider === 'string' && typeof command.modelId === 'string') {
        const model = current.modelRegistry.find(command.provider, command.modelId);
        if (!model || !advertisedModels(current).some(item => item.provider === model.provider && item.id === model.id)) return;
        const warn = () => current.ui.notify(`Remote control could not switch to ${model.provider}/${model.id}; check that provider's auth`, 'warning');
        pi.setModel(model).then(ok => { if (!ok) warn(); }, warn);
      } else if (command.type === 'set_thinking' && THINKING_LEVELS.includes(command.level as never))
        pi.setThinkingLevel(command.level as typeof THINKING_LEVELS[number]);
      else if (command.type === 'rename' && typeof command.name === 'string' && command.name.length <= 1024) pi.setSessionName(command.name.trim());
      else if (command.type === 'ask_answer') answerAsk(current, command);
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

  function sessionReplaced(current: ExtensionContext) {
    stopIdleWatch();
    mainSession = isMainSession(current);
    clearOmp();
    // The server binds each connection to the processId of its first hello, so a different session needs a fresh connection.
    // Drop it before anything below publishes for the new session on the old socket.
    if (socket && socketProcessId !== undefined && socketProcessId !== entryId(current)) dropSocket();
    runGeneration++;
    running = false;
    waiting = false;
    asking = false;
    stopped = false;
    runSignal = undefined;
    cancelAsk();
    todos = branchTodos(current.sessionManager.getBranch());
    clearPending(current);
    if (queued.length) restoreQueued(current);
    if (!ctx) return;
    ctx = current;
    publishTodos(current);
    if (socket?.readyState === WebSocket.OPEN) {
      hello(current);
      status(current, 'connected');
    } else {
      status(current, failed ? 'retrying' : 'connecting');
      connect();
    }
  }
  pi.on('session_start', (_event, current) => sessionReplaced(current));
  if (omp) {
    // These omp replacement events are not in Pi's ExtensionAPI overloads.
    const on = pi.on as (event: string, handler: (event: unknown, current: ExtensionContext) => void) => void;
    for (const type of ['session_switch', 'session_branch']) on(type, (_event, current) => sessionReplaced(current));
  }
  pi.on('session_info_changed', (_event, current) => {
    if (socket?.readyState === WebSocket.OPEN) hello(current);
  });
  for (const type of ['model_select', 'thinking_level_select'] as const) {
    pi.on(type, (_event, current) => {
      if (ctx && socket?.readyState === WebSocket.OPEN) sendHello(current);
    });
  }
  pi.on('session_tree', (_event, current) => {
    snapshot(current);
    todos = branchTodos(current.sessionManager.getBranch());
    publishTodos(current);
  });
  pi.on('message_start', (event, current) => {
    if (event.message.role !== 'user') return;
    const content = event.message.content;
    const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('');
    const index = pending.findIndex(item => item.text === text);
    if (index >= 0) {
      pending.splice(index, 1);
      publishQueue(current);
    }
  });
  for (const type of ['message_start', 'message_update', 'message_end', 'agent_start', 'ui_prompt_start', 'ui_prompt_end'] as const) {
    pi.on(type, (event, current) => {
      if (type === 'ui_prompt_start' || type === 'ui_prompt_end') waiting = type === 'ui_prompt_start';
      if (type === 'agent_start') {
        stopIdleWatch();
        asking = false;
        running = true;
        runGeneration++;
      }
      // Per low-level run, so keep the latest; it also catches a Stop pressed during a tool call.
      if (type === 'agent_start' || type === 'message_start') runSignal = current.signal ?? runSignal;
      if (type === 'agent_start' && queued.length && !stopped && !runSignal?.aborted) sendQueued(current);
      const usage = type === 'message_end' ? contextUsage(current) : null;
      const payload: object = usage ? { ...event, contextUsage: usage } : event;
      if (ctx && type === 'message_end' && socket?.readyState === WebSocket.OPEN && 'message' in event && title(current, event.message) !== lastTitle)
        hello(current, event.message);
      send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event: payload });
    });
  }
  function settle(current: ExtensionContext, event: object) {
    stopIdleWatch();
    runGeneration++;
    running = false;
    // Handled/transformed/rejected input has no public completion event; settlement is the final bound.
    clearPending(current);
    const usage = contextUsage(current);
    const reply = lastReply(current.sessionManager.getBranch());
    asking = reply.asking;
    const payload = { ...event, ...(usage ? { contextUsage: usage } : {}), asking, ...(reply.summary ? { summary: reply.summary } : {}) };
    // Tools may switch branches during a run.
    if (ctx && socket?.readyState === WebSocket.OPEN && gitBranch(current.cwd) !== lastBranch) sendHello(current);
    send({ type: 'event', processId: entryId(current), sessionId: current.sessionManager.getSessionId(), event: payload });
    // Native steering is owned by Pi; only restore prompts held between runs here.
    if (queued.length && (stopped || runSignal?.aborted)) restoreQueued(current);
    else if (queued.length) sendQueued(current);
    stopped = false;
    runSignal = undefined;
  }
  pi.on('agent_settled', (event, current) => settle(current, event));
  // Pi also emits agent_end per low-level run, so only omp listens. Never forward its message payload.
  if (omp) pi.on('agent_end', (event, current) => {
    const end = record(event);
    if (end?.willContinue === true || end?.awaitingAsyncWork === true) {
      watchIdle(current);
      return;
    }
    const messages = Array.isArray(end?.messages) ? end.messages : [];
    // omp appends placeholder toolResults after an aborted assistant, so check the last assistant, not the tail.
    const finalAssistant = record(messages.findLast(message => record(message)?.role === 'assistant'));
    if (finalAssistant?.stopReason === 'aborted') stopped = true;
    settle(current, { type: 'agent_settled' });
  });
  pi.on('tool_result', (event, current) => {
    if (event.toolName !== 'todo' || event.isError) return;
    const phases = todoPhases(record(event.details)?.phases);
    if (!phases) return;
    todos = flattenTodos(phases);
    publishTodos(current);
  });
  // Settle an omp run whose final agent_end was lost; a new run, settlement, or session stops the watch.
  // A scheduled continuation keeps omp non-idle without a new agent_start, so keep polling that run until idle.
  // The same tick retains Pi's held-prompt delivery after manual compaction without inventing a run.
  function stopIdleWatch() {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  function watchIdle(current: ExtensionContext, wait = 0) {
    stopIdleWatch();
    const generation = runGeneration;
    const timer = idleTimer = setTimeout(() => {
      if (idleTimer === timer) idleTimer = undefined;
      if (generation !== runGeneration) return;
      try {
        if (!current.isIdle()) {
          if (omp && running) watchIdle(current, IDLE_POLL_MS);
          return;
        }
        if (omp && running) {
          settle(current, { type: 'agent_settled' });
          return;
        }
        if (queued.length) {
          if (stopped) restoreQueued(current);
          else sendQueued(current);
        }
        stopped = false;
        runSignal = undefined;
      } catch { /* The runtime was replaced (/reload, /new) before the tick. */ }
    }, wait);
    timer.unref?.();
  }
  for (const type of ['session_compact', 'session_compact_failed'] as const)
    pi.on(type, (_event, current) => watchIdle(current));
  pi.on('session_shutdown', (_event, current) => {
    stopIdleWatch();
    runGeneration++;
    running = false;
    waiting = false;
    asking = false;
    stopped = false;
    runSignal = undefined;
    cancelAsk(current);
    clearPending(current);
    stop();
    clearOmp();
  });
  if (omp) {
    const on = pi.on as (event: string, handler: (event: unknown, current: ExtensionContext) => void) => void;
    for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'agent_start', 'agent_end']) on(type, () => refreshOmp());
    pi.events?.on('task:subagent:lifecycle', data => {
      const frame = record(data);
      const id = trimmed(frame?.id);
      if (!mainSession || !frame || !id) return;
      if (frame.status === 'started') {
        ompEnded.delete(id);
        // Lifecycle frames carry no timestamp, so receipt time stands in until a job reports its own.
        if (!ompSubagents.has(id)) ompSubagents.set(id, ompSubagentItem(id, frame, Date.now()));
      } else if (OMP_ENDED.includes(frame.status as string)) {
        ompEnded.add(id);
        ompSubagents.delete(id);
      } else return;
      refreshOmp();
    });
    pi.events?.on('task:subagent:progress', data => {
      const frame = record(data);
      const progress = record(frame?.progress);
      const id = trimmed(progress?.id);
      if (!mainSession || !frame || !progress || !id || ompEnded.has(id)) return;
      if (OMP_ENDED.includes(progress.status as string)) {
        ompEnded.add(id);
        ompSubagents.delete(id);
      } else ompSubagents.set(id, ompSubagentItem(id, frame, ompSubagents.get(id)?.startedAt ?? Date.now()));
      refreshOmp();
    });
  } else {
    // pi-processes and pi-subagents publish over pi.events; hosts without it (older Pi) just never show background work.
    pi.events?.on('processes:changed', () => {
      if (!ctx) return;
      refreshShells();
      publishBackground();
    });
    for (const channel of ['subagents:rpc:v1:ready', 'subagent:async-started', 'subagent:async-complete', 'subagent:child-status', 'subagent:foreground-complete'])
      pi.events?.on(channel, () => { if (ctx) refreshAgents(); });
  }
}

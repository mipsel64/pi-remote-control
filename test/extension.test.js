const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const load = () => import('../extensions/remote-control.ts').then(module => module.default);
function mockPi() {
  const handlers = new Map();
  const commands = new Map();
  const prompts = [];
  const modelsSet = [];
  const levels = [];
  const renames = [];
  let name;
  return {
    handlers, commands, prompts, modelsSet, levels, renames, setModelResult: true,
    on(type, fn) { handlers.set(type, fn); },
    registerCommand(name, command) { commands.set(name, command); },
    command(name, args, ctx) { return commands.get(name).handler(args, ctx); },
    getSessionName: () => name,
    setName(value) { name = value; },
    setSessionName(value) { renames.push(value); },
    sendUserMessage(...args) { prompts.push(args); },
    getThinkingLevel: () => 'medium',
    setThinkingLevel(level) { levels.push(level); },
    async setModel(model) { modelsSet.push(model); return this.setModelResult; },
    emit(type, ctx, event = { type }) { return handlers.get(type)?.(event, ctx); },
  };
}
const sonnet = { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true, thinkingLevelMap: { minimal: null, xhigh: 'x' }, contextWindow: 1 };
const mini = { provider: 'openai', id: 'mini', name: 'Mini', reasoning: false };
const hidden = { provider: 'openai', id: 'hidden', name: 'Hidden', reasoning: false };
function context(id = 's1') {
  const state = { id, idle: true, entries: [{ type: 'message', id: 'old', timestamp: '2025-01-02T03:04:05.000Z', message: { role: 'user', content: 'earlier' } }], aborted: 0, notices: [], statuses: [], inputs: [],
    model: sonnet, scoped: [], available: [sonnet, mini, sonnet] };
  return {
    state, cwd: '/work', hasUI: true,
    get model() { return state.model; },
    get scopedModels() { return state.scoped; },
    modelRegistry: { getAvailable: () => state.available, find: (provider, modelId) => [sonnet, mini, hidden].find(model => model.provider === provider && model.id === modelId) },
    ui: { notify: (...args) => state.notices.push(args), input: async () => state.inputs.shift(),
      theme: { fg: (_color, text) => text }, setStatus: (...args) => state.statuses.push(args),
      getEditorText: () => state.editor ?? '', setEditorText: text => { state.editor = text; } },
    sessionManager: { getSessionId: () => state.id, getBranch: () => state.entries },
    isIdle: () => state.idle,
    getContextUsage: () => state.usage,
    get signal() { return state.signal; },
    hasPendingMessages: () => state.pending ?? false,
    abort: () => { state.aborted++; },
  };
}

test('default XDG config uses prc and refuses legacy files without overwriting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rc-xdg-test-'));
  const keys = ['XDG_CONFIG_HOME', 'HOME', 'RC_CONFIG', 'PI_RC_URL', 'PI_RC_AGENT_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.HOME = dir;
  delete process.env.RC_CONFIG;
  delete process.env.PI_RC_URL;
  delete process.env.PI_RC_AGENT_TOKEN;
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    fs.rmSync(dir, { recursive: true });
  });
  const oldDir = path.join(dir, 'pi-remote-control');
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, 'client.json'), '{"token":"legacy"}', { mode: 0o600 });
  const pi = mockPi();
  (await load())(pi);
  const ctx = context();
  await pi.command('rc', 'setup', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /Legacy private config.*client.json.*without overwriting/);
  pi.command('rc', '', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /Legacy private config/);
  assert.equal(fs.existsSync(path.join(dir, 'prc')), false);
  fs.writeFileSync(path.join(oldDir, 'config.json'), '{"agentToken":"legacy"}', { mode: 0o600 });
  await pi.command('rc', 'setup', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /Legacy private config/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(oldDir, 'config.json'))).agentToken, 'legacy');
  fs.rmSync(oldDir, { recursive: true });
  const newDir = path.join(dir, 'prc');
  fs.mkdirSync(newDir);
  fs.writeFileSync(path.join(newDir, 'config.json'), JSON.stringify({ publicOrigin: 'http://127.0.0.1:8787', agentToken: 'new-token' }), { mode: 0o600 });
  await pi.command('rc', 'setup', ctx);
  assert.match(ctx.state.notices.at(-2)[0], /Endpoint: ws:\/\/127\.0\.0\.1:8787\/agent.*token: \[redacted\]/);
  assert.match(ctx.state.notices.at(-1)[0], /prc\/client.json/);
  ctx.state.inputs.push('wss://remote.example/agent');
  await pi.command('rc', 'setup', ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'client.json'))).url, 'wss://remote.example/agent');
  assert.equal(fs.statSync(path.join(newDir, 'client.json')).mode & 0o777, 0o600);
});

test('unconfigured extension registers /rc but opens no socket', async t => {
  const oldUrl = process.env.PI_RC_URL;
  const oldToken = process.env.PI_RC_AGENT_TOKEN;
  const oldConfig = process.env.RC_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rc-test-'));
  process.env.RC_CONFIG = path.join(dir, 'missing.json');
  delete process.env.PI_RC_URL;
  delete process.env.PI_RC_AGENT_TOKEN;
  t.after(() => {
    if (oldUrl === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = oldToken;
    if (oldConfig === undefined) delete process.env.RC_CONFIG; else process.env.RC_CONFIG = oldConfig;
    fs.rmSync(dir, { recursive: true });
  });
  const pi = mockPi();
  (await load())(pi);
  const ctx = context();
  pi.emit('session_start', ctx);
  assert.ok(pi.commands.has('rc'));
  pi.command('rc', 'status', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /off/);
  await pi.command('rc', 'setup', ctx);
  assert.match(ctx.state.notices.at(-2)[0], /Endpoint: \(none\).*token: \(missing\).*state: off/);
  assert.match(ctx.state.notices.at(-1)[0], /Client config:/);
  ctx.state.inputs.push('wss://remote.example/agent');
  await pi.command('rc', 'setup', ctx);
  const client = path.join(dir, 'client.json');
  assert.equal(JSON.parse(fs.readFileSync(client)).url, 'wss://remote.example/agent');
  assert.equal(fs.statSync(client).mode & 0o777, 0o600);
  pi.command('rc', '', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /not configured.*prc setup/);
  process.env.PI_RC_URL = 'ws://127.0.0.1:1/agent';
  pi.command('rc', '', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /both PI_RC_URL and PI_RC_AGENT_TOKEN/);
  await pi.command('rc', 'setup', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /Partial PI_RC_\* override/);
  assert.equal(JSON.parse(fs.readFileSync(client)).url, 'wss://remote.example/agent');
  assert.ok(!ctx.state.notices.some(([message]) => message.includes('missing.json')));
  delete process.env.PI_RC_URL;
  fs.writeFileSync(process.env.RC_CONFIG, '{"secret":"DO_NOT_ECHO"', { mode: 0o600 });
  pi.command('rc', '', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /config.*invalid/);
  assert.ok(!ctx.state.notices.at(-1)[0].includes('DO_NOT_ECHO'));
  fs.writeFileSync(process.env.RC_CONFIG, JSON.stringify({ publicOrigin: 'http://127.0.0.1:8787', agentToken: 'DO_NOT_ECHO' }));
  fs.chmodSync(process.env.RC_CONFIG, 0o644);
  pi.command('rc', '', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /config.*invalid/);
  assert.ok(!ctx.state.notices.at(-1)[0].includes('DO_NOT_ECHO'));
});

test('private config attaches current session only on /rc and /rc close disconnects', async t => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const oldUrl = process.env.PI_RC_URL;
  const oldToken = process.env.PI_RC_AGENT_TOKEN;
  const oldConfig = process.env.RC_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rc-test-'));
  const config = path.join(dir, 'config.json');
  const client = path.join(dir, 'client.json');
  fs.writeFileSync(config, JSON.stringify({ publicOrigin: `http://127.0.0.1:${wss.address().port}`, agentToken: 'config-token', adminPassword: 'UNCHANGED' }), { mode: 0o600 });
  process.env.RC_CONFIG = config;
  delete process.env.PI_RC_URL;
  delete process.env.PI_RC_AGENT_TOKEN;
  t.after(() => {
    if (oldUrl === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = oldToken;
    if (oldConfig === undefined) delete process.env.RC_CONFIG; else process.env.RC_CONFIG = oldConfig;
    fs.rmSync(dir, { recursive: true });
    wss.close();
  });
  const pi = mockPi();
  const ctx = context();
  (await load())(pi);
  pi.emit('session_start', ctx);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(wss.clients.size, 0);
  const connected = once(wss, 'connection');
  pi.command('rc', '', ctx);
  const [ws, request] = await connected;
  assert.equal(request.url, '/agent');
  assert.equal(request.headers.authorization, 'Bearer config-token');
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  for (let i = 0; i < 200 && !messages.some(msg => msg.type === 'snapshot'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(messages.find(msg => msg.type === 'snapshot')?.entries, ctx.state.entries);
  assert.equal(messages.find(msg => msg.type === 'hello')?.name, 'earlier');
  assert.equal(messages.find(msg => msg.type === 'hello')?.updatedAt, Date.parse(ctx.state.entries[0].timestamp));
  assert.deepEqual(ctx.state.statuses.at(-1), ['rc', '/rc connected']);
  assert.equal(ctx.state.notices.filter(([message]) => message === 'Remote control connected').length, 1);
  pi.command('rc', '', ctx);
  assert.equal(ctx.state.notices.filter(([message]) => message === 'Remote control connected').length, 1);
  pi.command('rc', 'status', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /connected/);
  const closed = once(ws, 'close');
  pi.command('rc', 'close', ctx);
  await closed;
  assert.deepEqual(ctx.state.statuses.at(-1), ['rc', undefined]);
  assert.match(ctx.state.notices.at(-1)[0], /closed/);
  pi.command('rc', 'status', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /off/);
  pi.command('rc', 'off', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /Use .*\/rc close/);
  fs.writeFileSync(client, JSON.stringify({ token: 'client-token' }), { mode: 0o600 });
  ctx.state.inputs.push(`ws://127.0.0.1:${wss.address().port}/agent`);
  await pi.command('rc', 'setup', ctx);
  assert.match(ctx.state.notices.at(-3)[0], /token: \[redacted\] \(client.json\)/);
  assert.ok(!ctx.state.notices.some(([message]) => message.includes('client-token')));
  assert.equal(JSON.parse(fs.readFileSync(client)).token, 'client-token');
  assert.equal(fs.statSync(client).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(config)).adminPassword, 'UNCHANGED');
  ctx.state.inputs.push('ws://public.example/agent');
  await pi.command('rc', 'setup', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /setup invalid/);
  assert.equal(JSON.parse(fs.readFileSync(client)).url, `ws://127.0.0.1:${wss.address().port}/agent`);
});


test('failed connection warns once, keeps retrying, and /rc close clears the indicator', async t => {
  const wss = new WebSocketServer({ port: 0, verifyClient: (_request, done) => done(false, 401, 'Unauthorized') });
  await once(wss, 'listening');
  const previous = [process.env.PI_RC_URL, process.env.PI_RC_AGENT_TOKEN];
  process.env.PI_RC_URL = `ws://127.0.0.1:${wss.address().port}/agent`;
  process.env.PI_RC_AGENT_TOKEN = 'PRIVATE_TOKEN';
  t.after(() => {
    if (previous[0] === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = previous[0];
    if (previous[1] === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = previous[1];
    wss.close();
  });
  const pi = mockPi();
  const ctx = context();
  (await load())(pi);
  pi.command('rc', '', ctx);
  for (let i = 0; i < 200 && !ctx.state.notices.some(([, level]) => level === 'warning'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ctx.state.notices.filter(([, level]) => level === 'warning').length, 1);
  assert.deepEqual(ctx.state.statuses.at(-1), ['rc', '/rc retrying']);
  assert.equal(ctx.state.notices.filter(([message]) => message === 'Remote control connected').length, 0);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(ctx.state.notices.filter(([, level]) => level === 'warning').length, 1);
  pi.command('rc', 'status', ctx);
  assert.match(ctx.state.notices.at(-1)[0], /retrying/);
  assert.ok(!ctx.state.notices.some(([message]) => message.includes('PRIVATE_TOKEN')));
  pi.command('rc', 'close', ctx);
  assert.deepEqual(ctx.state.statuses.at(-1), ['rc', undefined]);
});

test('authenticated snapshots, events, session ownership, follow-up and shutdown', async t => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const connections = [];
  const active = [];
  t.after(() => new Promise(resolve => {
    for (const [pi, ctx] of active) pi.emit('session_shutdown', ctx);
    for (const ws of connections) ws.terminate();
    wss.close(resolve);
  }));
  const oldUrl = process.env.PI_RC_URL;
  const oldToken = process.env.PI_RC_AGENT_TOKEN;
  const oldConfig = process.env.RC_CONFIG;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rc-test-'));
  process.env.RC_CONFIG = path.join(dir, 'config.json');
  fs.writeFileSync(process.env.RC_CONFIG, JSON.stringify({ publicOrigin: `http://127.0.0.1:${wss.address().port}`, agentToken: 'wrong-config-token' }), { mode: 0o600 });
  process.env.PI_RC_URL = `ws://127.0.0.1:${wss.address().port}/agent`;
  process.env.PI_RC_AGENT_TOKEN = 'secret';
  t.after(() => {
    if (oldUrl === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = oldToken;
    if (oldConfig === undefined) delete process.env.RC_CONFIG; else process.env.RC_CONFIG = oldConfig;
    fs.rmSync(dir, { recursive: true });
  });
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'Bearer secret');
    connections.push(ws);
  });
  const overridePi = mockPi();
  const overrideContext = context();
  (await load())(overridePi);
  await overridePi.command('rc', 'setup', overrideContext);
  assert.match(overrideContext.state.notices.at(-2)[0], /Endpoint: .*PI_RC_URL.*token: \[redacted\].*PI_RC_AGENT_TOKEN/);
  assert.match(overrideContext.state.notices.at(-1)[0], /override local config/);
  assert.equal(fs.existsSync(path.join(dir, 'client.json')), false);
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for command');
  }
  async function run(pi, ctx) {
    active.push([pi, ctx]);
    (await load())(pi);
    const connected = once(wss, 'connection');
    pi.emit('session_start', ctx);
    pi.command('rc', '', ctx);
    const [ws] = await connected;
    const queue = [];
    const waiters = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      const index = waiters.findIndex(wait => wait.match(msg));
      if (index < 0) queue.push(msg);
      else waiters.splice(index, 1)[0].resolve(msg);
    });
    function next(match = () => true) {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve: msg => { clearTimeout(timer); resolve(msg); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Timed out waiting for WS message')); }, 2000);
        waiters.push(waiter);
      });
    }
    return { ws, next };
  }
  const pi = mockPi();
  const ctx = context();
  const first = await run(pi, ctx);
  const hello = await first.next(msg => msg.type === 'hello');
  assert.equal(hello.sessionId, 's1');
  assert.equal(hello.busy, false);
  assert.equal(hello.name, 'earlier');
  assert.equal(hello.branch, null);
  assert.equal(hello.host, os.hostname().split('.')[0]);
  assert.equal(hello.waiting, false);
  assert.equal(hello.updatedAt, Date.parse(ctx.state.entries[0].timestamp));
  assert.deepEqual((await first.next(msg => msg.type === 'snapshot')).entries, ctx.state.entries);
  pi.setName('Named conversation');
  pi.emit('session_info_changed', ctx);
  assert.equal((await first.next(msg => msg.type === 'hello')).name, 'Named conversation');
  await first.next(msg => msg.type === 'snapshot');
  first.ws.send(JSON.stringify({ type: 'history', sessionId: 's1' }));
  assert.deepEqual((await first.next(msg => msg.type === 'snapshot')).entries, ctx.state.entries);
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 'wrong', text: 'stale' }));
  first.ws.send(JSON.stringify({ type: 'abort', sessionId: 'wrong' }));
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'new' }));
  await until(() => pi.prompts.length === 1);
  assert.deepEqual(pi.prompts, [['new', { deliverAs: 'followUp' }]]);
  ctx.state.idle = false;
  pi.emit('agent_start', ctx);
  assert.deepEqual((await first.next(msg => msg.type === 'event')).event, { type: 'agent_start' });
  const prompt = { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'Allow?' };
  pi.emit('ui_prompt_start', ctx, prompt);
  assert.deepEqual((await first.next(msg => msg.type === 'event')).event, prompt);
  pi.emit('session_info_changed', ctx);
  assert.equal((await first.next(msg => msg.type === 'hello')).waiting, true);
  await first.next(msg => msg.type === 'snapshot');
  pi.emit('ui_prompt_end', ctx, { ...prompt, type: 'ui_prompt_end' });
  assert.equal((await first.next(msg => msg.type === 'event')).event.type, 'ui_prompt_end');
  const saved = ctx.state.entries;
  const settle = async text => {
    ctx.state.entries = [...saved, { type: 'message', id: 'reply', message: { role: 'assistant', content: [{ type: 'text', text }] } }];
    pi.emit('agent_settled', ctx);
    return (await first.next(msg => msg.type === 'event' && msg.event.type === 'agent_settled')).event;
  };
  assert.deepEqual(await settle('## Done\n\nI updated **the** [server](http://x).\n\n```js\ncode?\n```\n\nShould I update `ui_prompt_start` docs?'),
    { type: 'agent_settled', asking: true, summary: 'Should I update ui_prompt_start docs?' });
  assert.deepEqual(await settle(`- All tests pass.\n\n${'x'.repeat(200)}`), { type: 'agent_settled', asking: false, summary: 'All tests pass.' });
  assert.equal((await settle('y'.repeat(200))).summary, `${'y'.repeat(159)}…`);
  ctx.state.usage = { tokens: 42, contextWindow: 1000, percent: 4.2 };
  assert.deepEqual((await settle('z')).contextUsage, { tokens: 42, contextWindow: 1000 });
  delete ctx.state.usage;
  ctx.state.entries = saved;
  // Busy prompts wait in the extension and reach Pi as one follow-up before the run settles.
  const queue = async () => (await first.next(msg => msg.type === 'event' && msg.event.type === 'queue_update')).event.queued;
  const settled = async () => {
    pi.emit('agent_settled', ctx);
    return (await first.next(msg => msg.type === 'event' && msg.event.type === 'agent_settled')).event;
  };
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'later' }));
  assert.deepEqual(await queue(), ['later']);
  const long = `  aa${'😀'.repeat(130)} tail\n`;
  const preview = `aa${'😀'.repeat(98)}…`;
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: long }));
  assert.deepEqual(await queue(), ['later', preview]);
  pi.emit('model_select', ctx, { type: 'model_select', model: sonnet, previousModel: sonnet, source: 'set' });
  assert.deepEqual((await first.next(msg => msg.type === 'hello')).queued, ['later', preview]);
  assert.equal(pi.prompts.length, 1);
  ctx.state.pending = true;
  await pi.emit('agent_before_settle', ctx, { type: 'agent_before_settle', outcome: 'completed' });
  delete ctx.state.pending;
  assert.deepEqual(pi.prompts.at(-1), [`later\n\n${long}`, { deliverAs: 'followUp' }]);
  assert.deepEqual(await queue(), []);
  // One that lands after agent_before_settle goes out as the run settles.
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'just in time' }));
  assert.deepEqual(await queue(), ['just in time']);
  await settled();
  assert.deepEqual(await queue(), []);
  assert.deepEqual(pi.prompts.at(-1), ['just in time', { deliverAs: 'followUp' }]);
  // A manual /compact is not a run: what waited on it goes out once Pi is idle again.
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'during compact' }));
  assert.deepEqual(await queue(), ['during compact']);
  ctx.state.idle = true;
  pi.emit('session_compact', ctx, { type: 'session_compact' });
  assert.deepEqual(await queue(), []);
  assert.deepEqual(pi.prompts.at(-1), ['during compact', { deliverAs: 'followUp' }]);
  ctx.state.idle = false;

  // Stop, from the browser or the terminal, returns queued text to Pi's editor instead of running it.
  ctx.state.editor = 'draft';
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'after stop' }));
  assert.deepEqual(await queue(), ['after stop']);
  first.ws.send(JSON.stringify({ type: 'abort', sessionId: 's1' }));
  await until(() => ctx.state.aborted === 1);
  await pi.emit('agent_before_settle', ctx, { type: 'agent_before_settle', outcome: 'aborted' });
  await settled();
  assert.deepEqual(await queue(), []);
  assert.equal(ctx.state.editor, 'after stop\n\ndraft');
  const terminalRun = new AbortController();
  ctx.state.signal = terminalRun.signal;
  ctx.state.editor = '';
  pi.emit('message_start', ctx, { type: 'message_start', message: { role: 'assistant', content: [] } });
  delete ctx.state.signal;
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'terminal stop' }));
  assert.deepEqual(await queue(), ['terminal stop']);
  terminalRun.abort();
  await settled();
  assert.deepEqual(await queue(), []);
  assert.equal(ctx.state.editor, 'terminal stop');
  assert.equal(pi.prompts.length, 4);
  ctx.state.entries.push({ type: 'message', id: 'next' });
  pi.emit('session_tree', ctx);
  assert.equal((await first.next(msg => msg.type === 'snapshot')).entries.length, 2);
  const huge = 'x'.repeat(33 * 1024 * 1024);
  ctx.state.entries = [{ type: 'message', message: { role: 'user', content: huge } }];
  pi.emit('session_tree', ctx);
  let transferId, total, parts = [];
  for (let index = 0; total === undefined || index < total; index++) {
    const chunk = await first.next(msg => msg.type === 'snapshot_chunk');
    transferId ??= chunk.snapshotId;
    total ??= chunk.total;
    assert.equal(chunk.snapshotId, transferId);
    assert.equal(chunk.index, index);
    assert.equal(chunk.total, total);
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 1024 * 1024);
    parts.push(chunk.data);
  }
  assert.ok(total > 250);
  assert.equal(JSON.parse(parts.join(''))[0].message.content, huge);
  parts = [];
  ctx.state.entries = [{ type: 'message', id: 'old' }, { type: 'message', id: 'next' }];
  const reconnected = once(wss, 'connection');
  assert.equal(ctx.state.notices.filter(([message]) => message === 'Remote control connected').length, 1);
  first.ws.terminate();
  const [again] = await reconnected;
  const reconnectMessages = [];
  again.on('message', raw => reconnectMessages.push(JSON.parse(raw.toString())));
  await until(() => reconnectMessages.some(msg => msg.type === 'snapshot'));
  assert.equal(ctx.state.notices.filter(([message]) => message === 'Remote control connected').length, 1);
  assert.equal(reconnectMessages.find(msg => msg.type === 'hello').processId, hello.processId);
  assert.equal(reconnectMessages.find(msg => msg.type === 'snapshot').entries.length, 2);
  assert.deepEqual(ctx.state.statuses.at(-1), ['rc', '/rc connected']);
  const closed = once(again, 'close');
  pi.emit('session_shutdown', ctx);
  await closed;

  // /new then /rc: a new runtime and session must get its own remote entry, not replace the old one.
  const replacement = mockPi();
  const secondCtx = context('s2');
  secondCtx.state.entries = [];
  secondCtx.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rc-git-'));
  t.after(() => fs.rmSync(secondCtx.cwd, { recursive: true }));
  execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: secondCtx.cwd });
  const second = await run(replacement, secondCtx);
  const freshHello = await second.next(msg => msg.type === 'hello');
  assert.notEqual(freshHello.processId, hello.processId);
  assert.equal(freshHello.name, 'New Session');
  assert.equal(freshHello.branch, 'feature');
  assert.equal((await second.next(msg => msg.type === 'snapshot')).sessionId, 's2');
  replacement.emit('message_end', secondCtx, { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '  Fix the\nlogin flow ' }] } });
  assert.equal((await second.next(msg => msg.type === 'hello')).name, 'Fix the login flow');
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: secondCtx.cwd });
  replacement.emit('agent_settled', secondCtx);
  assert.equal((await second.next(msg => msg.type === 'hello')).branch, 'other');
  const closedAgain = once(second.ws, 'close');
  replacement.emit('session_shutdown', secondCtx);
  await closedAgain;

  // /reload (new runtime, same session) keeps that session's entry.
  const reloaded = await run(mockPi(), context('s1'));
  assert.equal((await reloaded.next(msg => msg.type === 'hello')).processId, hello.processId);
  assert.equal(connections.length, 4);
});

test('hello advertises models and thinking; remote model and thinking changes are validated', async t => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const previous = [process.env.PI_RC_URL, process.env.PI_RC_AGENT_TOKEN];
  process.env.PI_RC_URL = `ws://127.0.0.1:${wss.address().port}/agent`;
  process.env.PI_RC_AGENT_TOKEN = 'secret';
  const pi = mockPi();
  const ctx = context();
  t.after(() => new Promise(resolve => {
    pi.emit('session_shutdown', ctx);
    if (previous[0] === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = previous[0];
    if (previous[1] === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = previous[1];
    for (const ws of wss.clients) ws.terminate();
    wss.close(resolve);
  }));
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out');
  }
  ctx.state.usage = { tokens: 1234.4, contextWindow: 200000, percent: 0.6 };
  (await load())(pi);
  const connected = once(wss, 'connection');
  pi.command('rc', '', ctx);
  const [ws] = await connected;
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await until(() => messages.some(msg => msg.type === 'hello'));
  const hello = messages.find(msg => msg.type === 'hello');
  assert.deepEqual(hello.model, { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'] });
  assert.deepEqual(hello.context, { tokens: 1234, contextWindow: 200000 });
  assert.equal(hello.thinkingLevel, 'medium');
  assert.deepEqual(hello.models, [
    { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true },
    { provider: 'openai', id: 'mini', name: 'Mini', reasoning: false }]);

  const send = message => ws.send(JSON.stringify({ sessionId: 's1', ...message }));
  send({ type: 'set_model', provider: 'openai', modelId: 'hidden' });
  send({ type: 'set_model', provider: 'openai', modelId: 'missing' });
  send({ type: 'set_model', sessionId: 'stale', provider: 'openai', modelId: 'mini' });
  send({ type: 'set_model', provider: 'openai', modelId: 'mini' });
  await until(() => pi.modelsSet.length === 1);
  assert.equal(pi.modelsSet[0], mini);
  pi.setModelResult = false;
  send({ type: 'set_model', provider: 'anthropic', modelId: 'sonnet' });
  await until(() => ctx.state.notices.some(([message, level]) => level === 'warning' && /could not switch to anthropic\/sonnet/.test(message)));
  send({ type: 'set_thinking', level: 'extreme' });
  send({ type: 'set_thinking', sessionId: 'stale', level: 'low' });
  send({ type: 'set_thinking', level: 'high' });
  await until(() => pi.levels.length === 1);
  assert.deepEqual(pi.levels, ['high']);
  send({ type: 'rename', sessionId: 'stale', name: 'Stale' });
  send({ type: 'rename', name: 7 });
  send({ type: 'rename', name: 'x'.repeat(1025) });
  send({ type: 'rename', name: '  Renamed  ' });
  send({ type: 'rename', name: '' });
  await until(() => pi.renames.length === 2);
  assert.deepEqual(pi.renames, ['Renamed', '']);

  messages.length = 0;
  ctx.state.model = mini;
  pi.emit('model_select', ctx, { type: 'model_select', model: mini, previousModel: sonnet, source: 'set' });
  await until(() => messages.some(msg => msg.type === 'hello'));
  assert.deepEqual(messages[0].model, { provider: 'openai', id: 'mini', name: 'Mini', reasoning: false, thinkingLevels: ['off'] });
  ctx.state.scoped = [{ model: mini }];
  pi.emit('thinking_level_select', ctx, { type: 'thinking_level_select', level: 'off', previousLevel: 'high' });
  await until(() => messages.filter(msg => msg.type === 'hello').length === 2);
  assert.deepEqual(messages.filter(msg => msg.type === 'hello')[1].models, [{ provider: 'openai', id: 'mini', name: 'Mini', reasoning: false }]);
  assert.ok(!messages.some(msg => msg.type === 'snapshot'));
  pi.setModelResult = true;
  send({ type: 'set_model', provider: 'anthropic', modelId: 'sonnet' });
  send({ type: 'set_model', provider: 'openai', modelId: 'mini' });
  await until(() => pi.modelsSet.length === 3);
  assert.equal(pi.modelsSet[2], mini);

  // Pi has no catalog-changed event, so a models request must recompute the list live.
  messages.length = 0;
  ctx.state.scoped = [];
  ctx.state.available = [hidden, sonnet];
  send({ type: 'models', sessionId: 'stale' });
  send({ type: 'models' });
  await until(() => messages.length === 1);
  assert.deepEqual(messages[0], { type: 'models', processId: hello.processId, sessionId: 's1', models: [
    { provider: 'openai', id: 'hidden', name: 'Hidden', reasoning: false },
    { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true }] });
  ctx.state.scoped = [{ model: mini }];
  send({ type: 'models' });
  await until(() => messages.length === 2);
  assert.deepEqual(messages[1].models, [{ provider: 'openai', id: 'mini', name: 'Mini', reasoning: false }]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(messages.length, 2);
});

test('missing scopedModels falls back to available models for hello, models, and set_model', async t => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const previous = [process.env.PI_RC_URL, process.env.PI_RC_AGENT_TOKEN];
  process.env.PI_RC_URL = `ws://127.0.0.1:${wss.address().port}/agent`;
  process.env.PI_RC_AGENT_TOKEN = 'secret';
  const pi = mockPi();
  const ctx = context();
  delete ctx.scopedModels;
  t.after(() => new Promise(resolve => {
    pi.emit('session_shutdown', ctx);
    if (previous[0] === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = previous[0];
    if (previous[1] === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = previous[1];
    for (const ws of wss.clients) ws.terminate();
    wss.close(resolve);
  }));
  (await load())(pi);
  const connected = once(wss, 'connection');
  pi.command('rc', '', ctx);
  const [ws] = await connected;
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for WS message');
  }
  const expected = [
    { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true },
    { provider: 'openai', id: 'mini', name: 'Mini', reasoning: false },
  ];
  await until(() => messages.some(msg => msg.type === 'hello'));
  assert.deepEqual(messages.find(msg => msg.type === 'hello').models, expected);
  ws.send(JSON.stringify({ type: 'models', sessionId: 's1' }));
  await until(() => messages.some(msg => msg.type === 'models'));
  assert.deepEqual(messages.find(msg => msg.type === 'models').models, expected);
  ws.send(JSON.stringify({ type: 'set_model', sessionId: 's1', provider: 'openai', modelId: 'hidden' }));
  ws.send(JSON.stringify({ type: 'set_model', sessionId: 's1', provider: 'openai', modelId: 'mini' }));
  ws.send(JSON.stringify({ type: 'models', sessionId: 's1' }));
  await until(() => messages.filter(msg => msg.type === 'models').length === 2);
  assert.deepEqual(pi.modelsSet, [mini]);
});

// Synchronous like Pi's bus: handlers start inside emit.
function bus() {
  const handlers = new Map();
  return {
    on(channel, handler) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return () => handlers.set(channel, handlers.get(channel).filter(item => item !== handler));
    },
    emit(channel, data) { for (const handler of handlers.get(channel) ?? []) handler(data); },
  };
}

test('background shells and subagents come from other extensions over pi.events', async t => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const previous = [process.env.PI_RC_URL, process.env.PI_RC_AGENT_TOKEN];
  process.env.PI_RC_URL = `ws://127.0.0.1:${wss.address().port}/agent`;
  process.env.PI_RC_AGENT_TOKEN = 'secret';
  const pi = mockPi();
  pi.events = bus();
  const ctx = context();
  t.after(() => new Promise(resolve => {
    pi.emit('session_shutdown', ctx);
    if (previous[0] === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = previous[0];
    if (previous[1] === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = previous[1];
    for (const ws of wss.clients) ws.terminate();
    wss.close(resolve);
  }));
  // Stand-ins: pi-processes answers inside emit, pi-subagents answers later on a per-request reply channel.
  // Longer than both the one-line preview (200) and the full form (1000).
  const long = `gh run watch 1 --exit-status${' --interval 30'.repeat(90)}`;
  let processes = [
    { id: 'p1', name: 'watch-ci', command: long, status: 'running', startTime: 1000 },
    { id: 'p2', name: 'build', command: 'make', status: 'exited', startTime: 900 },
    { id: 'p3', name: ' ', command: 'npm   run dev', status: 'terminating', startTime: 'soon' },
    { name: 'no id', command: 'x', status: 'running' },
  ];
  pi.events.on('processes:request:list', ({ reply }) => reply(processes));
  let fleet = { version: 1, totalActive: 2, omitted: 0, entries: [
    { key: 'fleet-1', agent: 'reviewer', role: 'security', model: 'gpt-6-sol', startedAt: 2000, tokens: { input: 1, output: 2, total: 3 } },
    { key: 'fleet-2', agent: ' ', startedAt: 1 },
  ] };
  const statusRequests = [];
  pi.events.on('subagents:rpc:v1:request', request => statusRequests.push(request));
  const answer = () => {
    for (const { requestId } of statusRequests.splice(0))
      pi.events.emit(`subagents:rpc:v1:reply:${requestId}`, { version: 1, requestId, method: 'status', success: true, data: { fleet } });
  };
  (await load())(pi);
  const connected = once(wss, 'connection');
  pi.command('rc', '', ctx);
  const [ws] = await connected;
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for WS message');
  }
  const updates = () => messages.filter(msg => msg.type === 'event' && msg.event.type === 'background_update').map(msg => msg.event.background);
  const watch = { kind: 'shell', id: 'p1', label: 'watch-ci', detail: `${long.slice(0, 199)}…`, full: `${long.slice(0, 999)}…`, startedAt: 1000 };
  const dev = { kind: 'shell', id: 'p3', label: 'npm run dev', detail: 'npm run dev', startedAt: null };
  const reviewer = { kind: 'agent', id: 'fleet-1', label: 'reviewer · security', detail: 'gpt-6-sol', startedAt: 2000 };

  await until(() => messages.some(msg => msg.type === 'hello'));
  assert.deepEqual(messages.find(msg => msg.type === 'hello').background, [watch, dev]);
  assert.deepEqual(statusRequests.map(({ version, method }) => ({ version, method })), [{ version: 1, method: 'status' }]);
  answer();
  await until(() => updates().length === 1);
  assert.deepEqual(updates()[0], [watch, dev, reviewer]);

  // Changes during an in-flight status request collapse into one follow-up request.
  pi.events.emit('subagent:child-status', {});
  pi.events.emit('subagent:async-started', {});
  pi.events.emit('subagent:async-complete', {});
  assert.equal(statusRequests.length, 1);
  fleet = { ...fleet, entries: [] };
  answer();
  await until(() => updates().length === 2);
  assert.deepEqual(updates()[1], [watch, dev]);
  assert.equal(statusRequests.length, 1);
  answer();

  processes = [];
  pi.events.emit('processes:changed', { reason: 'ended' });
  await until(() => updates().length === 3);
  assert.deepEqual(updates()[2], []);
  // Unchanged lists send nothing.
  pi.events.emit('processes:changed', { reason: 'cleared' });
  pi.events.emit('subagent:async-complete', {});
  answer();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(updates().length, 3);

  // A synchronous replier works too.
  fleet = { version: 1, entries: [{ key: 'fleet-3', agent: 'worker', startedAt: 3000 }] };
  const offSync = pi.events.on('subagents:rpc:v1:request', () => answer());
  pi.events.emit('subagent:async-started', {});
  await until(() => updates().length === 4);
  assert.deepEqual(updates()[3], [{ kind: 'agent', id: 'fleet-3', label: 'worker', detail: '', startedAt: 3000 }]);
  // No reply within 5 s means pi-subagents stopped answering, so its last list is dropped.
  offSync();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pi.events.emit('subagent:async-complete', {});
  t.mock.timers.tick(5000);
  t.mock.timers.reset();
  await until(() => updates().length === 5);
  assert.deepEqual(updates()[4], []);
  statusRequests.length = 0;

  // A full shell list still leaves room for subagents.
  processes = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, name: `sleep ${i}`, command: 'sleep 60', status: 'running', startTime: 1 }));
  fleet = { version: 1, entries: [{ key: 'fleet-4', agent: 'scout', startedAt: 4 }] };
  pi.events.on('subagents:rpc:v1:request', () => answer());
  pi.events.emit('processes:changed', { reason: 'started' });
  await until(() => updates().length === 6);
  assert.equal(updates()[5].length, 20);
  pi.events.emit('subagent:async-started', {});
  await until(() => updates().length === 7);
  assert.deepEqual(updates()[6].map(item => item.kind).filter(kind => kind === 'shell').length, 19);
  assert.equal(updates()[6].at(-1).label, 'scout');
});

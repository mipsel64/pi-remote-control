const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');

const load = () => import('../extensions/remote-control.ts').then(module => module.default);
const nativeParameters = { schema: 'native ask' };
const nativeAsk = {
  name: 'ask', label: 'Native Ask', description: 'native ask', parameters: nativeParameters,
  promptSnippet: 'Native ask snippet', promptGuidelines: ['Use native ask'], examples: [{ questions: [] }],
  renderCall: () => 'native call', renderResult: () => 'native result',
  approval: 'read', strict: true, concurrency: 'exclusive', loadMode: 'discoverable',
  sourceInfo: { source: 'builtin' }, execute: () => { throw new Error('native execute must be wrapped'); },
};
function mockPi(omp = false) {
  const handlers = new Map();
  const commands = new Map();
  const prompts = [];
  const modelsSet = [];
  const levels = [];
  const renames = [];
  const tools = new Map();
  let name;
  return {
    handlers, commands, prompts, modelsSet, levels, renames, tools, setModelResult: true,
    // omp injects schema builders, lists its native tools and has an event bus; Pi has none of these.
    ...(omp && { arktype: {}, registerTool: tool => tools.set(tool.name, tool),
      getAllTools: () => [nativeAsk], events: bus() }),
    on(type, fn) { handlers.set(type, [...(handlers.get(type) ?? []), fn]); },
    registerCommand(name, command) { commands.set(name, command); },
    command(name, args, ctx) { return commands.get(name).handler(args, ctx); },
    getSessionName: () => name,
    setName(value) { name = value; },
    setSessionName(value) { renames.push(value); },
    sendUserMessage(...args) { prompts.push(args); },
    getThinkingLevel: () => 'medium',
    setThinkingLevel(level) { levels.push(level); },
    async setModel(model) { modelsSet.push(model); return this.setModelResult; },
    emit(type, ctx, event = { type }) { for (const handler of handlers.get(type) ?? []) handler(event, ctx); },
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
    // omp's Main-owned async jobs.
    getAsyncJobSnapshot: () => ({ running: state.jobs ?? [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
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

test('authenticated snapshots, events, session ownership, steering and shutdown', async t => {
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
  assert.equal((await first.next(msg => msg.event?.type === 'rc_close')).sessionId, 's1');
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
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: ' ' }));
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: '😀'.repeat(4097) }));
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'new' }));
  await until(() => pi.prompts.length === 1);
  assert.deepEqual(pi.prompts, [['new', { deliverAs: 'steer' }]]);
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
  const queue = async () => (await first.next(msg => msg.type === 'event' && msg.event.type === 'queue_update')).event.queued;
  const consume = async text => {
    pi.emit('message_start', ctx, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
    await first.next(msg => msg.type === 'event' && msg.event.type === 'message_start');
    return queue();
  };
  const settled = async () => {
    pi.emit('agent_settled', ctx);
    return (await first.next(msg => msg.type === 'event' && msg.event.type === 'agent_settled')).event;
  };
  const activeRun = new AbortController();
  ctx.state.signal = activeRun.signal;
  pi.emit('agent_start', ctx);
  await first.next(msg => msg.type === 'event' && msg.event.type === 'agent_start');
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'steer now' }));
  await until(() => pi.prompts.length === 2);
  assert.deepEqual(await queue(), ['steer now']);
  const long = `  aa${'😀'.repeat(130)} tail\n`;
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: long }));
  await until(() => pi.prompts.length === 3);
  assert.deepEqual(await queue(), ['steer now', `aa${'😀'.repeat(98)}…`]);
  assert.deepEqual(pi.prompts.slice(1), [['steer now', { deliverAs: 'steer' }], [long, { deliverAs: 'steer' }]]);
  pi.emit('model_select', ctx, { type: 'model_select', model: sonnet, previousModel: sonnet, source: 'set' });
  assert.deepEqual((await first.next(msg => msg.type === 'hello')).queued, ['steer now', `aa${'😀'.repeat(98)}…`]);
  assert.deepEqual(await consume('steer now'), [`aa${'😀'.repeat(98)}…`]);
  assert.deepEqual(await consume(long), []);
  assert.equal(pi.handlers.has('agent_before_settle'), false);
  delete ctx.state.signal;
  await settled();
  assert.equal(pi.prompts.length, 3);

  // Between low-level runs, hold the prompt until the next run can accept steering.
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'during retry' }));
  assert.deepEqual(await queue(), ['during retry']);
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'retry sibling' }));
  assert.deepEqual(await queue(), ['during retry', 'retry sibling']);
  ctx.state.signal = new AbortController().signal;
  pi.emit('agent_start', ctx);
  assert.deepEqual(await queue(), ['during retry retry sibling']);
  assert.deepEqual(await consume('during retry\n\nretry sibling'), []);
  assert.deepEqual(pi.prompts.at(-1), ['during retry\n\nretry sibling', { deliverAs: 'steer' }]);
  delete ctx.state.signal;
  // A message that arrives after the last run starts once the agent settles.
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'just in time' }));
  assert.deepEqual(await queue(), ['just in time']);
  await settled();
  assert.deepEqual(await queue(), ['just in time']);
  assert.deepEqual(await consume('just in time'), []);
  assert.deepEqual(pi.prompts.at(-1), ['just in time', { deliverAs: 'steer' }]);
  // A manual /compact cannot accept prompts; join and send them once Pi is idle.
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'during compact' }));
  assert.deepEqual(await queue(), ['during compact']);
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: long }));
  assert.deepEqual(await queue(), ['during compact', `aa${'😀'.repeat(98)}…`]);
  ctx.state.idle = true;
  pi.emit('session_compact', ctx, { type: 'session_compact' });
  const combined = `during compact\n\n${long}`;
  assert.deepEqual(await queue(), []);
  assert.deepEqual(pi.prompts.at(-1), [combined, { deliverAs: 'steer' }]);
  ctx.state.idle = false;

  // Stop restores only the extension-held queue; Pi owns native steering restoration.
  ctx.state.editor = 'draft';
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'after stop' }));
  assert.deepEqual(await queue(), ['after stop']);
  first.ws.send(JSON.stringify({ type: 'abort', sessionId: 's1' }));
  await until(() => ctx.state.aborted === 1);
  await settled();
  assert.deepEqual(await queue(), []);
  assert.equal(ctx.state.editor, 'after stop\n\ndraft');
  const terminalRun = new AbortController();
  ctx.state.signal = terminalRun.signal;
  ctx.state.editor = '';
  pi.emit('message_start', ctx, { type: 'message_start', message: { role: 'assistant', content: [] } });
  terminalRun.abort();
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'terminal stop' }));
  assert.deepEqual(await queue(), ['terminal stop']);
  delete ctx.state.signal;
  await settled();
  assert.deepEqual(await queue(), []);
  assert.equal(ctx.state.editor, 'terminal stop');
  assert.equal(pi.prompts.length, 6);

  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'cancel compact' }));
  assert.deepEqual(await queue(), ['cancel compact']);
  first.ws.send(JSON.stringify({ type: 'abort', sessionId: 's1' }));
  await until(() => ctx.state.aborted === 2);
  ctx.state.idle = true;
  pi.emit('session_compact_failed', ctx, { type: 'session_compact_failed' });
  assert.deepEqual(await queue(), []);
  assert.equal(ctx.state.editor, 'cancel compact\n\nterminal stop');
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'after compact stop' }));
  await until(() => pi.prompts.length === 7);
  assert.deepEqual(pi.prompts.at(-1), ['after compact stop', { deliverAs: 'steer' }]);
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

  let tick, cancelled = false;
  const timer = { unref() {} };
  const interval = t.mock.method(global, 'setInterval', callback => { tick = callback; return timer; });
  const cancel = t.mock.method(global, 'clearInterval', value => { assert.equal(value, timer); cancelled = true; });
  ctx.state.idle = false;
  ctx.state.signal = new AbortController().signal;
  first.ws.send(JSON.stringify({ type: 'prompt', sessionId: 's1', text: 'invalidated context' }));
  assert.deepEqual(await queue(), ['invalidated context']);
  const sessionId = ctx.sessionManager.getSessionId;
  const pendingMessages = ctx.hasPendingMessages;
  ctx.sessionManager.getSessionId = () => { throw new Error('Invalidated context'); };
  ctx.hasPendingMessages = () => { throw new Error('Invalidated context'); };
  try {
    assert.doesNotThrow(tick);
    assert.ok(cancelled, 'invalidated context stops its pending timer without publishing');
  } finally {
    ctx.sessionManager.getSessionId = sessionId;
    ctx.hasPendingMessages = pendingMessages;
    interval.mock.restore();
    cancel.mock.restore();
  }
  ctx.state.idle = true;
  delete ctx.state.signal;
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
  assert.deepEqual(reconnectMessages.find(msg => msg.type === 'hello').queued, []);
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settledWithin = (promise, ms) => Promise.race([promise.then(() => 'settled', () => 'settled'), delay(ms).then(() => 'pending')]);

// A connected extension runtime. omp stands in for a host that emits agent_end (never agent_settled) and can re-register native tools.
async function attached(t, { omp = false, piEvents = false, beforeAttach } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const previous = [process.env.PI_RC_URL, process.env.PI_RC_AGENT_TOKEN];
  process.env.PI_RC_URL = `ws://127.0.0.1:${wss.address().port}/agent`;
  process.env.PI_RC_AGENT_TOKEN = 'secret';
  const pi = mockPi(omp);
  if (piEvents) pi.events = bus();
  const ctx = context();
  t.after(() => new Promise(resolve => {
    pi.emit('session_shutdown', ctx);
    if (previous[0] === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = previous[0];
    if (previous[1] === undefined) delete process.env.PI_RC_AGENT_TOKEN; else process.env.PI_RC_AGENT_TOKEN = previous[1];
    for (const ws of wss.clients) ws.terminate();
    wss.close(resolve);
  }));
  (await load())(pi);
  pi.emit('session_start', ctx);
  await beforeAttach?.(pi, ctx);
  const connected = once(wss, 'connection');
  pi.command('rc', '', ctx);
  const [ws] = await connected;
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await delay(10);
    }
    throw new Error('Timed out waiting for WS message');
  }
  const hellos = () => messages.filter(msg => msg.type === 'hello');
  const events = type => messages.filter(msg => msg.type === 'event' && msg.event.type === type).map(msg => msg.event);
  // session_info_changed makes the extension send a fresh hello.
  async function hello() {
    const count = hellos().length;
    pi.emit('session_info_changed', ctx);
    await until(() => hellos().length > count);
    return hellos().at(-1);
  }
  await until(() => hellos().length === 1);
  return { pi, ctx, ws, wss, messages, until, hellos, events, hello, send: message => ws.send(JSON.stringify({ sessionId: 's1', ...message })) };
}

test('omp ask override is opt-in and preserves all exposed native metadata', async t => {
  const { pi } = await attached(t, { omp: true, beforeAttach: async (pi, ctx) => {
    assert.equal(pi.tools.size, 0);
    await pi.command('rc', 'status', ctx);
    assert.equal(pi.tools.size, 0);
  } });
  const tool = pi.tools.get('ask');
  for (const key of ['name', 'label', 'description', 'parameters', 'promptSnippet', 'promptGuidelines', 'examples',
    'renderCall', 'renderResult', 'approval', 'strict', 'concurrency', 'loadMode', 'sourceInfo'])
    assert.equal(tool[key], nativeAsk[key], key);
  assert.notEqual(tool.execute, nativeAsk.execute);
});

test('omp final agent_end settles once without forwarding messages or a duplicate agent_end', async t => {
  const { pi, ctx, hello, events, messages, until } = await attached(t, { omp: true });
  // omp's isIdle() is also false between continuations and during compaction.
  ctx.state.idle = false;
  assert.equal((await hello()).busy, false);
  pi.emit('agent_start', ctx);
  assert.equal((await hello()).busy, true);
  for (const flags of [{ willContinue: true }, { willContinue: true, awaitingAsyncWork: true }, { awaitingAsyncWork: true }]) {
    pi.emit('agent_end', ctx, { type: 'agent_end', messages: [{ role: 'assistant', content: 'DO_NOT_FORWARD' }], ...flags });
    assert.equal((await hello()).busy, true);
  }
  assert.equal(events('agent_settled').length, 0);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [{ role: 'assistant', content: 'DO_NOT_FORWARD' }] });
  assert.equal((await hello()).busy, false);
  await until(() => events('agent_settled').length === 1);
  assert.equal(events('agent_end').length, 0);
  assert.deepEqual(events('agent_settled'), [{ type: 'agent_settled', asking: false }]);
  assert.equal(JSON.stringify(messages).includes('DO_NOT_FORWARD'), false);
});

test('omp idle watcher settles missing finals after continuation or retry and ignores stale watchers', async t => {
  const { pi, ctx, hello, events, until } = await attached(t, { omp: true });
  for (const flags of [{ willContinue: true }, { awaitingAsyncWork: true }]) {
    ctx.state.idle = false;
    pi.emit('agent_start', ctx);
    pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], ...flags });
    ctx.state.idle = true;
    const count = events('agent_settled').length + 1;
    await until(() => events('agent_settled').length === count);
    assert.equal((await hello()).busy, false);
  }

  // A continuation that does start invalidates the previous run's idle callback.
  ctx.state.idle = false;
  pi.emit('agent_start', ctx);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], willContinue: true });
  pi.emit('agent_start', ctx);
  await delay(20);
  assert.equal(events('agent_settled').length, 2);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [] });
  await until(() => events('agent_settled').length === 3);
  await delay(20);
  assert.equal(events('agent_settled').length, 3);
});

test('omp compaction tick settles an abandoned run, but compaction alone is not a run', async t => {
  const { pi, ctx, hello, events, until } = await attached(t, { omp: true });
  ctx.state.idle = true;
  pi.emit('session_compact', ctx, { type: 'session_compact' });
  await delay(20);
  assert.equal(events('agent_settled').length, 0);
  assert.equal((await hello()).busy, false);

  ctx.state.idle = false;
  pi.emit('agent_start', ctx);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], awaitingAsyncWork: true });
  pi.emit('session_compact', ctx, { type: 'session_compact' });
  ctx.state.idle = true;
  pi.emit('session_compact', ctx, { type: 'session_compact' });
  await until(() => events('agent_settled').length === 1);
  assert.equal((await hello()).busy, false);
});

test('omp session switch and branch clear stale run state and restore held prompts', async t => {
  const { pi, ctx, hellos, events, until, send } = await attached(t, { omp: true });
  for (const type of ['session_switch', 'session_branch']) {
    ctx.state.idle = false;
    pi.emit('agent_start', ctx);
    pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], willContinue: true });
    pi.emit('ui_prompt_start', ctx, { type: 'ui_prompt_start' });
    send({ type: 'abort' });
    send({ type: 'prompt', text: `held ${type}` });
    await until(() => events('queue_update').at(-1)?.queued.length === 1);
    ctx.state.idle = true;
    const count = hellos().length;
    pi.emit(type, ctx, { type });
    await until(() => hellos().length > count);
    assert.equal(hellos().at(-1).busy, false);
    assert.equal(hellos().at(-1).waiting, false);
    assert.deepEqual(hellos().at(-1).queued, []);
    assert.match(ctx.state.editor, new RegExp(`held ${type}`));
    send({ type: 'prompt', text: `after ${type}` });
    await until(() => pi.prompts.at(-1)?.[0] === `after ${type}`);
  }
  assert.equal(events('agent_settled').length, 0);
});

test('omp aborted final assistant restores held prompts instead of auto-sending them', async t => {
  const { pi, ctx, events, until, send } = await attached(t, { omp: true });
  ctx.state.idle = false;
  ctx.state.editor = 'draft';
  pi.emit('agent_start', ctx);
  send({ type: 'prompt', text: 'held after abort' });
  await until(() => events('queue_update').at(-1)?.queued.length === 1);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted', content: 'DO_NOT_FORWARD' }] });
  await until(() => events('agent_settled').length === 1);
  assert.equal(ctx.state.editor, 'held after abort\n\ndraft');
  assert.equal(pi.prompts.length, 0);
  assert.deepEqual(events('queue_update').at(-1).queued, []);
  assert.equal(events('agent_end').length, 0);

  pi.emit('agent_start', ctx);
  send({ type: 'prompt', text: 'send after normal completion' });
  await until(() => events('queue_update').at(-1)?.queued.includes('send after normal completion'));
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: 'done' }] });
  await until(() => events('agent_settled').length === 2);
  assert.deepEqual(pi.prompts, [['send after normal completion', { deliverAs: 'steer' }]]);
});

test('omp hello reconciles stale busy with isIdle without treating compaction as a run', async t => {
  const { pi, ctx, hello } = await attached(t, { omp: true });
  ctx.state.idle = false;
  assert.equal((await hello()).busy, false);
  pi.emit('agent_start', ctx);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], willContinue: true });
  assert.equal((await hello()).busy, true);
  ctx.state.idle = true;
  assert.equal((await hello()).busy, false);

});

test('omp idle watcher keeps watching while a scheduled continuation stays non-idle', async t => {
  const { pi, ctx, hello, events, until } = await attached(t, { omp: true });
  ctx.state.idle = false;
  pi.emit('agent_start', ctx);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], willContinue: true });
  // omp stays busy past the first tick without emitting another agent_start.
  await delay(250);
  assert.equal(events('agent_settled').length, 0);
  assert.equal((await hello()).busy, true);
  // The continuation finishes without a final agent_end.
  ctx.state.idle = true;
  await until(() => events('agent_settled').length === 1);
  await delay(250);
  assert.equal(events('agent_settled').length, 1);

  // A new run stops the watch; its own final agent_end settles exactly once.
  ctx.state.idle = false;
  pi.emit('agent_start', ctx);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], willContinue: true });
  await delay(150);
  pi.emit('agent_start', ctx);
  ctx.state.idle = true;
  await delay(250);
  assert.equal(events('agent_settled').length, 1);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [] });
  await until(() => events('agent_settled').length === 2);

  // Session replacement stops the watch too.
  ctx.state.idle = false;
  pi.emit('agent_start', ctx);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [], willContinue: true });
  await delay(150);
  pi.emit('session_switch', ctx, { type: 'session_switch' });
  ctx.state.idle = true;
  await delay(250);
  assert.equal(events('agent_settled').length, 2);
});

test('omp session switch and branch to another session reconnect instead of rebinding the socket', async t => {
  const { pi, ctx, ws, wss, messages, hellos, until } = await attached(t, { omp: true });
  // Like the server: a connection belongs to the processId of its first hello and rejects any other.
  const bound = [];
  const track = (socket, received) => {
    const entry = { socket, received, processId: undefined, closed: false };
    socket.on('close', () => { entry.closed = true; });
    bound.push(entry);
    return entry;
  };
  const first = track(ws, messages);
  first.processId = hellos()[0].processId;
  let previous = first;
  for (const [type, id] of [['session_switch', 's2'], ['session_branch', 's3']]) {
    const connected = once(wss, 'connection');
    const sentBefore = previous.received.length;
    ctx.state.id = id;
    pi.emit(type, ctx, { type });
    const [socket] = await connected;
    const received = [];
    socket.on('message', raw => received.push(JSON.parse(raw.toString())));
    const entry = track(socket, received);
    await until(() => received.some(msg => msg.type === 'hello') && previous.closed);
    const hello = received.find(msg => msg.type === 'hello');
    entry.processId = hello.processId;
    assert.equal(hello.sessionId, id);
    assert.notEqual(hello.processId, previous.processId);
    // Nothing for the new session went out on the old connection.
    assert.deepEqual(previous.received.slice(sentBefore).filter(msg => msg.processId !== previous.processId), []);
    previous = entry;
  }
  for (const entry of bound) assert.deepEqual(entry.received.filter(msg => 'processId' in msg && msg.processId !== entry.processId), []);
  assert.deepEqual(ctx.state.notices.filter(([, level]) => level === 'warning'), []);
  assert.deepEqual(ctx.state.statuses.at(-1), ['rc', '/rc connected']);
  // /rc stays opted in for the new session.
  previous.socket.send(JSON.stringify({ type: 'prompt', sessionId: 's3', text: 'after replace' }));
  await until(() => pi.prompts.at(-1)?.[0] === 'after replace');
});

test('omp aborted assistant followed by placeholder tool results still restores held prompts', async t => {
  const { pi, ctx, events, until, send } = await attached(t, { omp: true });
  ctx.state.idle = false;
  ctx.state.editor = 'draft';
  pi.emit('agent_start', ctx);
  send({ type: 'prompt', text: 'held after tool abort' });
  await until(() => events('queue_update').at(-1)?.queued.length === 1);
  pi.emit('agent_end', ctx, { type: 'agent_end', messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', stopReason: 'aborted', content: [{ type: 'toolCall', id: 'a' }, { type: 'toolCall', id: 'b' }] },
    { role: 'toolResult', toolCallId: 'a', isError: true, content: [{ type: 'text', text: 'aborted' }] },
    { role: 'toolResult', toolCallId: 'b', isError: true, content: [{ type: 'text', text: 'aborted' }] },
  ] });
  await until(() => events('agent_settled').length === 1);
  assert.equal(ctx.state.editor, 'held after tool abort\n\ndraft');
  assert.equal(pi.prompts.length, 0);
  assert.deepEqual(events('queue_update').at(-1).queued, []);
});

test('omp todo results publish the flattened plan; hello and branch changes keep it current', async t => {
  const { pi, ctx, until, events, hellos, hello } = await attached(t, { omp: true });
  assert.deepEqual((await hello()).todos, []);
  const phases = [
    { name: 'Setup', tasks: [{ content: 'Install deps', status: 'in_progress', notes: ['n'] }, { content: 'Wire CI', status: 'blocked', blocker: 'Needs token' }] },
    { name: 'Ship', tasks: [{ content: 'Release', status: 'pending' }] },
  ];
  const expected = [
    { id: '0.0', content: 'Install deps', status: 'in_progress', phase: 'Setup' },
    { id: '0.1', content: 'Wire CI', status: 'blocked', phase: 'Setup', blocker: 'Needs token' },
    { id: '1.0', content: 'Release', status: 'pending', phase: 'Ship' },
  ];
  const result = (details, extra = {}) => ({ type: 'tool_result', toolCallId: 'call', toolName: 'todo', input: {}, content: [], isError: false, details, ...extra });
  pi.emit('tool_result', ctx, result({ op: 'init', phases, storage: 'session' }));
  await until(() => events('todo_update').length === 1);
  assert.deepEqual(events('todo_update')[0].todos, expected);
  assert.deepEqual((await hello()).todos, expected);

  // Other tools, failed calls and malformed details are not the plan; an unchanged plan is not re-sent.
  pi.emit('tool_result', ctx, result({ op: 'init', phases: [] }, { toolName: 'bash' }));
  pi.emit('tool_result', ctx, result({ op: 'done', phases: [] }, { isError: true }));
  pi.emit('tool_result', ctx, result({ op: 'view', phases: [{ name: 'Bad', tasks: [{ content: 'x', status: 'wat' }] }] }));
  pi.emit('tool_result', ctx, result(undefined));
  pi.emit('tool_result', ctx, result({ op: 'view', phases, storage: 'session' }));
  await delay(30);
  assert.equal(events('todo_update').length, 1);

  // The server drops items past its text caps, so long text is cut and blank tasks are skipped.
  pi.emit('tool_result', ctx, result({ op: 'append', phases: [{ name: 'p'.repeat(300), tasks: [{ content: 'c'.repeat(2000), status: 'completed' }, { content: '  ', status: 'pending' }] }] }));
  await until(() => events('todo_update').length === 2);
  const [cut, ...rest] = events('todo_update')[1].todos;
  assert.deepEqual([rest.length, cut.content.length, cut.phase.length, cut.status], [0, 1024, 256, 'completed']);

  // A new session recovers the latest durable plan: the user's own edit wins over views and failed results.
  const toolResult = (details, extra = {}) => ({ type: 'message', id: 'r', message: { role: 'toolResult', toolName: 'todo', details, ...extra } });
  ctx.state.entries = [
    toolResult({ op: 'init', phases }),
    { type: 'custom', customType: 'user_todo_edit', data: { phases: [{ name: 'Edited', tasks: [{ content: 'By hand', status: 'completed' }] }] } },
    toolResult({ op: 'done', phases }, { isError: true }),
    toolResult({ op: 'view', phases }),
  ];
  const count = hellos().length;
  pi.emit('session_start', ctx);
  await until(() => hellos().length > count);
  assert.deepEqual(hellos().at(-1).todos, [{ id: '0.0', content: 'By hand', status: 'completed', phase: 'Edited' }]);

  // Navigating the tree, switching sessions, and changing branches all recompute the durable plan.
  ctx.state.entries = [];
  let updateCount = events('todo_update').length + 1;
  pi.emit('session_tree', ctx);
  await until(() => events('todo_update').length === updateCount);
  assert.deepEqual(events('todo_update').at(-1).todos, []);
  for (const type of ['session_switch', 'session_branch']) {
    ctx.state.entries = [toolResult({ op: 'init', phases: [{ name: type, tasks: [{ content: `Plan ${type}`, status: 'pending' }] }] })];
    updateCount = events('todo_update').length + 1;
    const helloCount = hellos().length;
    pi.emit(type, ctx, { type });
    await until(() => events('todo_update').length === updateCount && hellos().length > helloCount);
    const expected = [{ id: '0.0', content: `Plan ${type}`, status: 'pending', phase: type }];
    assert.deepEqual(events('todo_update').at(-1).todos, expected);
    assert.deepEqual(hellos().at(-1).todos, expected);
  }
});

// Stand-in for omp's native ask: a dialog that stays open until it is answered or its signal aborts.
function nativeDialog() {
  const calls = [];
  return { calls, invokeTool: (params, options) => new Promise((resolve, reject) => {
    calls.push({ params, options, resolve });
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Ask input was cancelled'), { name: 'AbortError' })), { once: true });
  }) };
}
const askParams = { questions: [
  { id: 'storage', question: 'Database?', header: 'DB', options: [{ label: 'SQLite', description: ' embedded ', preview: 'not sent' }, { label: 'Postgres' }], recommended: 0 },
  { id: 'features', question: 'Features?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multi: true },
] };
const askPrompt = [
  { id: 'storage', question: 'Database?', header: 'DB', options: [{ label: 'SQLite', description: 'embedded' }, { label: 'Postgres' }], recommended: 0 },
  { id: 'features', question: 'Features?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multi: true },
];

test('omp ask: browser answers resolve the native tool call and dismiss the local dialog', async t => {
  const { pi, until, events, hello, send } = await attached(t, { omp: true });
  const tool = pi.tools.get('ask');
  assert.deepEqual([tool.name, tool.description, tool.parameters, tool.approval, tool.concurrency], ['ask', 'native ask', nativeParameters, 'read', 'exclusive']);
  const native = nativeDialog();
  const run = tool.execute('call-1', askParams, undefined, undefined, { invokeTool: native.invokeTool });
  await until(() => events('ask_update').length === 1);
  const { ask } = events('ask_update')[0];
  assert.equal(typeof ask.requestId, 'string');
  assert.deepEqual(ask.questions, askPrompt);
  assert.deepEqual((await hello()).ask, ask);
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].params, askParams);

  const good = [{ id: 'storage', selectedOptions: ['SQLite'] }, { id: 'features', selectedOptions: ['A', 'C'], customInput: 'D\r\nE' }];
  const answer = (answers, requestId = ask.requestId, extra = {}) => send({ type: 'ask_answer', requestId, answers, ...extra });
  answer(good, 'stale');
  answer(good, ask.requestId, { sessionId: 'other' });
  answer([]);
  answer('everything');
  answer([{ id: 'nope', selectedOptions: [] }]);
  answer([{ id: 'storage', selectedOptions: ['MySQL'] }]);
  answer([{ id: 'storage', selectedOptions: ['SQLite', 'Postgres'] }]);
  answer([{ id: 'storage', selectedOptions: [] }]);
  answer([{ id: 'storage', selectedOptions: ['SQLite'] }, { id: 'storage', selectedOptions: ['Postgres'] }]);
  answer([{ id: 'features', selectedOptions: ['A', 'A'] }]);
  answer([{ id: 'features', selectedOptions: ['A'], customInput: 7 }]);
  assert.equal(await settledWithin(run, 50), 'pending');
  assert.equal(native.calls[0].options.signal.aborted, false);
  assert.equal(events('ask_update').length, 1);

  answer(good);
  assert.deepEqual(await run, {
    content: [{ type: 'text', text: 'User answers:\nstorage: SQLite\nfeatures: [A, C] + "D\nE"' }],
    details: { results: [
      { id: 'storage', question: 'Database?', options: ['SQLite', 'Postgres'], multi: false, selectedOptions: ['SQLite'] },
      { id: 'features', question: 'Features?', options: ['A', 'B', 'C'], multi: true, selectedOptions: ['A', 'C'], customInput: 'D\nE' }] },
  });
  assert.equal(native.calls[0].options.signal.aborted, true);
  await until(() => events('ask_update').length === 2);
  assert.equal(events('ask_update')[1].ask, null);
  assert.equal((await hello()).ask, null);
  answer(good);
  await delay(30);
  assert.equal(events('ask_update').length, 2);

  const resolveAsk = async (params, answers) => {
    const count = events('ask_update').length;
    const dialog = nativeDialog();
    const pending = tool.execute('call', params, undefined, undefined, { invokeTool: dialog.invokeTool });
    await until(() => events('ask_update').length === count + 1);
    send({ type: 'ask_answer', requestId: events('ask_update').at(-1).ask.requestId, answers });
    const result = await pending;
    await until(() => events('ask_update').length === count + 2);
    return result;
  };
  const single = { questions: [askParams.questions[0]] };
  assert.deepEqual(await resolveAsk(single, [{ id: 'storage', selectedOptions: ['Postgres'] }]), {
    content: [{ type: 'text', text: 'User selected: Postgres' }],
    details: { question: 'Database?', options: ['SQLite', 'Postgres'], multi: false, selectedOptions: ['Postgres'], customInput: undefined } });
  const custom = await resolveAsk(single, [{ id: 'storage', selectedOptions: [], customInput: 'Mongo\nAtlas' }]);
  assert.equal(custom.content[0].text, 'User provided custom input:\n  Mongo\n  Atlas');
  assert.deepEqual(custom.details.selectedOptions, []);
  assert.equal(custom.details.customInput, 'Mongo\nAtlas');
  const none = await resolveAsk({ questions: [askParams.questions[1]] }, [{ id: 'features', selectedOptions: [] }]);
  assert.equal(none.content[0].text, 'User did not select any options');
});

test('omp ask: a local answer or abort clears the browser prompt; session end cancels it; unanswerable asks stay local', async t => {
  const { pi, ctx, until, events, hellos, send } = await attached(t, { omp: true });
  const tool = pi.tools.get('ask');
  const open = async (params = askParams, signal) => {
    const count = events('ask_update').length;
    const dialog = nativeDialog();
    const run = tool.execute('call', params, signal, undefined, { invokeTool: dialog.invokeTool });
    await until(() => events('ask_update').length === count + 1);
    return { dialog, run, requestId: events('ask_update').at(-1).ask.requestId };
  };
  const cleared = count => until(() => events('ask_update').length === count && events('ask_update').at(-1).ask === null);

  // The terminal user answers first: their result is returned untouched and a late browser answer does nothing.
  const local = await open();
  const localResult = { content: [{ type: 'text', text: 'User selected: SQLite' }], details: { question: 'Database?' } };
  local.dialog.calls[0].resolve(localResult);
  assert.equal(await local.run, localResult);
  await cleared(2);
  send({ type: 'ask_answer', requestId: local.requestId, answers: [{ id: 'storage', selectedOptions: ['SQLite'] }] });
  await delay(30);
  assert.equal(events('ask_update').length, 2);

  // Aborting the tool call (Esc, Stop) rejects it and clears the prompt.
  const outer = new AbortController();
  const aborted = await open(askParams, outer.signal);
  outer.abort();
  await assert.rejects(aborted.run, { name: 'AbortError' });
  await cleared(4);

  // An ask the browser cannot answer exactly goes straight to the native tool with the caller's own signal.
  const duplicate = { questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A' }, { label: 'A' }] }] };
  const signal = new AbortController().signal;
  const dialog = nativeDialog();
  const run = tool.execute('call', duplicate, signal, undefined, { invokeTool: dialog.invokeTool });
  assert.equal(dialog.calls[0].options.signal, signal);
  dialog.calls[0].resolve(localResult);
  assert.equal(await run, localResult);
  await delay(30);
  assert.equal(events('ask_update').length, 4);

  // A replaced session dismisses the dialog; its hello reports no ask.
  const replaced = await open();
  const count = hellos().length;
  pi.emit('session_start', ctx);
  await assert.rejects(replaced.run, { name: 'AbortError' });
  assert.equal(replaced.dialog.calls[0].options.signal.aborted, true);
  await until(() => hellos().length > count);
  assert.equal(hellos().at(-1).ask, null);

  // Shutdown does the same and tells the browser before the socket closes.
  const shutdown = await open();
  pi.emit('session_shutdown', ctx);
  await assert.rejects(shutdown.run, { name: 'AbortError' });
  await cleared(7);
});

// Frames as omp v18 emits them (task/executor.ts): lifecycle carries no timestamp or assignment; progress nests live state.
const lifecycle = (status, extra = {}) => ({ id: 'Probe', agent: 'task', agentSource: 'bundled', parentToolCallId: 'call-1', detached: true, status, sessionFile: '/tmp/Probe.jsonl', index: 0, ...extra });
const progress = (state, extra = {}) => ({ index: 0, agent: 'task', agentSource: 'bundled', task: 'Complete assignment thoroughly:\n\nReview the diff\nCarefully',
  assignment: 'Review the diff\nCarefully', parentToolCallId: 'call-1', detached: true, sessionFile: '/tmp/Probe.jsonl',
  progress: { index: 0, id: 'Probe', agent: 'task', status: 'running', toolCount: 0, durationMs: 5, ...state }, ...extra });

test('omp depth-1 subagents appear from lifecycle and progress frames and leave when they end', async t => {
  const { pi, until, events, hello } = await attached(t, { omp: true });
  const updates = () => events('background_update').map(event => event.background);
  const before = Date.now();
  pi.events.emit('task:subagent:lifecycle', lifecycle('started'));
  await until(() => updates().length === 1);
  const [started] = updates()[0];
  assert.ok(started.startedAt >= before && started.startedAt <= Date.now());
  assert.deepEqual(started, { kind: 'agent', id: 'Probe', label: 'Probe', detail: '', startedAt: started.startedAt });

  // The best current activity is the detail; the assignment is the expanded form. A non-generic agent type joins the label.
  pi.events.emit('task:subagent:progress', progress({ lastIntent: 'Reading files', currentToolIntent: 'Grepping for TODO' }, { agent: 'reviewer' }));
  await until(() => updates().length === 2);
  const reviewing = { kind: 'agent', id: 'Probe', label: 'Probe · reviewer', detail: 'Grepping for TODO', full: 'Review the diff Carefully', startedAt: started.startedAt };
  assert.deepEqual(updates()[1], [reviewing]);
  assert.deepEqual((await hello()).background, [reviewing]);
  pi.events.emit('task:subagent:progress', progress({ lastIntent: 'Reading files' }));
  await until(() => updates().length === 3);
  assert.deepEqual(updates()[2], [{ ...reviewing, label: 'Probe', detail: 'Reading files' }]);
  pi.events.emit('task:subagent:progress', progress({}));
  await until(() => updates().length === 4);
  assert.deepEqual(updates()[3], [{ ...reviewing, label: 'Probe', detail: 'Review the diff' }]);

  pi.events.emit('task:subagent:lifecycle', lifecycle('completed'));
  await until(() => updates().length === 5);
  assert.deepEqual(updates()[4], []);
  // A late coalesced progress frame does not bring an ended subagent back.
  pi.events.emit('task:subagent:progress', progress({ lastIntent: 'late' }));
  await delay(30);
  assert.equal(updates().length, 5);
  assert.deepEqual((await hello()).background, []);
});

test('omp async task jobs and their subagent frames show once, keyed by id', async t => {
  const { pi, ctx, until, events } = await attached(t, { omp: true });
  const updates = () => events('background_update').map(event => event.background);
  ctx.state.jobs = [
    { id: 'Probe', type: 'task', status: 'running', label: 'Probe', startTime: 1000, agentId: 'Probe', ownerId: 'Main' },
    { id: 'bg_2', type: 'eval', status: 'running', label: 'python', startTime: 1100, ownerId: 'Main' },
  ];
  pi.emit('tool_execution_end', ctx, { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'task' });
  await until(() => updates().length === 1);
  assert.deepEqual(updates()[0], [{ kind: 'agent', id: 'Probe', label: 'Probe', detail: '', startedAt: 1000 }]);

  // The job's start time wins over receipt time.
  pi.events.emit('task:subagent:lifecycle', lifecycle('started'));
  pi.events.emit('task:subagent:progress', progress({ currentToolIntent: 'Grepping' }));
  await until(() => updates().length === 2);
  assert.deepEqual(updates().at(-1), [{ kind: 'agent', id: 'Probe', label: 'Probe', detail: 'Grepping', full: 'Review the diff Carefully', startedAt: 1000 }]);

  // The job outlives the subagent until it settles.
  pi.events.emit('task:subagent:lifecycle', lifecycle('completed'));
  await until(() => updates().length === 3);
  assert.deepEqual(updates()[2], [{ kind: 'agent', id: 'Probe', label: 'Probe', detail: '', startedAt: 1000 }]);
  ctx.state.jobs = [];
  pi.emit('tool_execution_update', ctx, { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'task' });
  await until(() => updates().length === 4);
  assert.deepEqual(updates()[3], []);
});

test('omp task jobs whose id differs from the subagent id still show once', async t => {
  const { pi, ctx, until, events } = await attached(t, { omp: true });
  const updates = () => events('background_update').map(event => event.background);
  ctx.state.jobs = [{ id: 'Probe-2', type: 'task', status: 'running', label: 'Probe-2', startTime: 3000, agentId: 'Probe', ownerId: 'Main' }];
  pi.events.emit('task:subagent:lifecycle', lifecycle('started'));
  pi.events.emit('task:subagent:progress', progress({ currentToolIntent: 'Grepping' }));
  await until(() => updates().at(-1)?.[0]?.detail === 'Grepping');
  assert.deepEqual(updates().at(-1), [{ kind: 'agent', id: 'Probe', label: 'Probe', detail: 'Grepping', full: 'Review the diff Carefully', startedAt: 3000 }]);
});

test('omp async bash jobs show as shells until a refresh tick finds them gone', async t => {
  const { pi, ctx, until, events, hello } = await attached(t, { omp: true });
  const updates = () => events('background_update').map(event => event.background);
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => t.mock.timers.reset());
  ctx.state.jobs = [{ id: 'bg_1', type: 'bash', status: 'running', label: 'sleep 5', command: 'sleep 5', startTime: 2000, ownerId: 'Main' }];
  pi.emit('tool_execution_end', ctx, { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash' });
  await until(() => updates().length === 1);
  const sleeping = { kind: 'shell', id: 'bg_1', label: 'sleep 5', detail: 'sleep 5', startedAt: 2000 };
  assert.deepEqual(updates()[0], [sleeping]);
  assert.deepEqual((await hello()).background, [sleeping]);

  // Jobs settle silently, so only the slow refresh notices.
  ctx.state.jobs = [];
  t.mock.timers.tick(1999);
  await delay(20);
  assert.equal(updates().length, 1);
  t.mock.timers.tick(1);
  await until(() => updates().length === 2);
  assert.deepEqual(updates()[1], []);
  // Nothing left running stops the refresh.
  ctx.state.jobs = [{ id: 'bg_9', type: 'bash', status: 'running', label: 'sleep 9', command: 'sleep 9', startTime: 3000, ownerId: 'Main' }];
  t.mock.timers.tick(10000);
  await delay(20);
  assert.equal(updates().length, 2);
});

test('Pi ignores omp background channels, and omp subagent sessions never publish them', async t => {
  const jobs = [{ id: 'bg_1', type: 'bash', status: 'running', label: 'sleep 5', command: 'sleep 5', startTime: 2000, ownerId: 'Main' }];
  for (const options of [{ piEvents: true }, { omp: true, beforeAttach: (_pi, ctx) => { ctx.agent = { kind: 'sub' }; } }]) {
    const { pi, ctx, events, hello, hellos } = await attached(t, options);
    ctx.state.jobs = jobs;
    assert.deepEqual(hellos()[0].background, []);
    pi.events.emit('task:subagent:lifecycle', lifecycle('started'));
    pi.events.emit('task:subagent:progress', progress({ currentToolIntent: 'Grepping' }));
    for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'agent_start'])
      pi.emit(type, ctx, { type, toolCallId: 'call-1', toolName: 'bash' });
    await delay(30);
    assert.deepEqual(events('background_update'), []);
    assert.deepEqual((await hello()).background, []);
  }
});

test('rpiv mapping preserves original question and option indexes and exact text', async () => {
  const { normalizeRpivPrompt, mapRpivAnswer } = await import('../extensions/remote-control.ts');
  const option = label => ({ label, description: '', hasPreview: false });
  const prompt = normalizeRpivPrompt({ toolCallId: 'tool', questions: [
    { question: ' First? ', header: '', multiSelect: false, options: [option(' A '), option('B')] },
    { question: 'Second?', header: 'H', multiSelect: true, options: [option('X'), option('Y'), option('Z')] },
  ] }, 'prompt', ['q1', 'q2']);
  assert.equal(prompt.kind, 'rpiv');
  assert.equal(prompt.questions[0].question, ' First? ');
  assert.deepEqual(prompt.questions[0].options[0], { label: ' A ' });
  const command = { type: 'ask_answer', sessionId: 'session', requestId: 'prompt', attemptId: 'attempt', globalNote: ' note ', answers: [
    { id: 'q2', selectedOptions: ['Z', 'X'], customInput: ' extra\r\ntext ', notes: ' n ' },
    { id: 'q1', selectedOptions: [' A '] },
  ] };
  assert.deepEqual(mapRpivAnswer(prompt, command, 'process', 'tool', 'native'), { ok: true, payload: {
    toolCallId: 'tool', requestId: 'native', globalNote: ' note ', answers: [
      { questionIndex: 0, optionIndexes: [0] },
      { questionIndex: 1, optionIndexes: [0, 2], text: ' extra\r\ntext ', notes: ' n ' },
    ],
  } });
  const invalid = answers => mapRpivAnswer(prompt, { ...command, answers }, 'process', 'tool', 'native');
  for (const answers of [[], [command.answers[0]], [command.answers[0], command.answers[0]],
    [{ id: 'q1', selectedOptions: ['B'], customInput: 'other' }, command.answers[0]],
    [{ id: 'q1', selectedOptions: ['B'] }, { id: 'q2', selectedOptions: ['X', 'X'] }],
    [{ id: 'q1', selectedOptions: ['B'] }, { id: 'q2', selectedOptions: [], customInput: '  ' }]])
    assert.equal(invalid(answers).code, 'invalid_answer');
  assert.deepEqual(mapRpivAnswer(prompt, { ...command, answers: [], cancel: true }, 'process', 'tool', 'native'),
    { ok: true, payload: { toolCallId: 'tool', requestId: 'native', globalNote: ' note ', cancel: true } });
  assert.equal(mapRpivAnswer(prompt, { ...command, cancel: true }, 'process', 'tool', 'native').code, 'invalid_payload');
  assert.equal(mapRpivAnswer(prompt, { ...command, globalNote: 'é'.repeat(8193) }, 'process', 'tool', 'native').code, 'invalid_payload');
  assert.equal(mapRpivAnswer(prompt, { ...command, padding: 'x'.repeat(65536) }, 'process', 'tool', 'native').code, 'invalid_payload');
});

test('rpiv mapping refuses prompts that cannot be represented faithfully', async () => {
  const { normalizeRpivPrompt } = await import('../extensions/remote-control.ts');
  const option = { label: 'A', description: '', hasPreview: false };
  const question = { question: 'Question?', header: '', multiSelect: false, options: [option] };
  const reason = (q, ids = ['id']) => normalizeRpivPrompt({ toolCallId: 'tool', questions: [q] }, 'request', ids).reason;
  assert.equal(reason({ ...question, options: [option, option] }), 'malformed');
  assert.equal(reason({ ...question, options: [{ ...option, hasPreview: true }] }), 'preview');
  assert.equal(reason({ ...question, question: 'x'.repeat(1025) }), 'oversize');
  assert.equal(reason(question, []), 'malformed');
  assert.equal(normalizeRpivPrompt({ questions: [question] }, 'request', ['id']).reason, 'malformed');
  assert.equal(reason({ ...question, multiSelect: undefined }), 'malformed');
  assert.equal(normalizeRpivPrompt({ questions: [question] }, '', ['id']), undefined);
});

test('rpiv mapping enforces serialized prompt byte boundary without clipping', async () => {
  const { normalizeRpivPrompt } = await import('../extensions/remote-control.ts');
  const questions = Array.from({ length: 2 }, (_, index) => ({
    question: `Question ${index}?`, header: '', multiSelect: false,
    options: Array.from({ length: 40 }, (_, i) => ({ label: `Option ${i}`, description: 'é' + 'x'.repeat(1023), hasPreview: false })),
  }));
  const wire = () => ({ kind: 'rpiv', requestId: 'prompt', questions: questions.map((q, i) => ({
    id: `q${i}`, question: q.question, options: q.options.map(({ label, description }) => ({ label, description })), multi: false,
  })) });
  let excess = Buffer.byteLength(JSON.stringify(wire())) - 65536;
  for (const q of questions) for (const option of q.options) {
    const removed = Math.min(excess, option.description.length - 1);
    option.description = option.description.slice(0, option.description.length - removed);
    excess -= removed;
    if (!excess) break;
  }
  assert.equal(Buffer.byteLength(JSON.stringify(wire())), 65536);
  const event = { toolCallId: 'tool', questions };
  assert.deepEqual(normalizeRpivPrompt(event, 'prompt', ['q0', 'q1']), wire());
  questions[0].options[0].description += 'x';
  assert.equal(Buffer.byteLength(JSON.stringify(wire())), 65537);
  assert.deepEqual(normalizeRpivPrompt(event, 'prompt', ['q0', 'q1']), { kind: 'terminal_only', requestId: 'prompt', reason: 'oversize' });
});

test('rpiv mapping rejects invalid or stale correlation IDs even for cancellation', async () => {
  const { normalizeRpivPrompt, mapRpivAnswer } = await import('../extensions/remote-control.ts');
  const prompt = normalizeRpivPrompt({ toolCallId: 'tool', questions: [
    { question: 'Q?', header: '', multiSelect: false, options: [] },
  ] }, 'prompt', ['question']);
  const command = { type: 'ask_answer', requestId: 'prompt', attemptId: 'attempt', cancel: true };
  const map = (input, tool = 'tool', native = 'native') => mapRpivAnswer(prompt, input, 'process', tool, native);
  assert.equal(map(command).ok, true);
  for (const change of [{ requestId: '' }, { requestId: 'stale' }, { requestId: 'x'.repeat(257) },
    { attemptId: undefined }, { attemptId: '' }, { attemptId: 'x'.repeat(257) }, { attemptId: 'prompt' }])
    assert.equal(map({ ...command, ...change }).code, 'invalid_payload');
  for (const [tool, native] of [['', 'native'], ['x'.repeat(257), 'native'], ['tool', ''],
    ['tool', 'x'.repeat(257)], ['tool', 'prompt'], ['tool', 'attempt']])
    assert.equal(map(command, tool, native).code, 'invalid_payload');
});

test('rpiv bridge maps indexed answers and handles immediate rejection, retry and native success', async t => {
  const { pi, events, until, send, hello } = await attached(t, { piEvents: true });
  const prompt = { toolCallId: 'native-1', questions: [
    { question: 'First?', header: '', multiSelect: false, options: [{ label: 'A', description: '', hasPreview: false }] },
    { question: 'Second?', header: '', multiSelect: true, options: [{ label: 'B', description: '', hasPreview: false }, { label: 'C', description: '', hasPreview: false }] },
  ] };
  const emitted = [];
  pi.events.on('rpiv:ask-user:answer', data => {
    emitted.push(data);
    pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: data.toolCallId, requestId: data.requestId, ok: emitted.length > 1, ...(emitted.length === 1 ? { code: 'invalid_answer' } : {}) });
  });
  pi.events.emit('rpiv:ask-user:prompt', prompt);
  await until(() => events('ask_update').length > 0);
  const ask = (await hello()).ask;
  const answers = [{ id: ask.questions[1].id, selectedOptions: ['C', 'B'], customInput: 'other', notes: 'note' }, { id: ask.questions[0].id, selectedOptions: ['A'] }];
  send({ type: 'ask_answer', requestId: ask.requestId, attemptId: 'attempt-1', answers, globalNote: 'global' });
  await until(() => events('ask_rejected').length === 1);
  assert.deepEqual(events('ask_rejected')[0], { type: 'ask_rejected', requestId: ask.requestId, attemptId: 'attempt-1', code: 'invalid_answer' });
  assert.deepEqual(emitted[0].answers, [{ questionIndex: 0, optionIndexes: [0] }, { questionIndex: 1, optionIndexes: [0, 1], text: 'other', notes: 'note' }]);
  assert.equal(emitted[0].globalNote, 'global');
  send({ type: 'ask_answer', requestId: ask.requestId, attemptId: 'attempt-2', cancel: true });
  await until(() => emitted.length === 2);
  assert.equal(emitted[1].cancel, true);
  assert.notEqual(emitted[0].requestId, emitted[1].requestId);
  assert.equal((await hello()).ask, null);
  pi.events.emit('rpiv:ask-user:blocked', { toolCallId: 'native-1', active: true });
  assert.equal((await hello()).ask, null);
});

test('rpiv FIFO closes queued prompts, guards delayed results and clears on rc close', async t => {
  const { pi, ctx, events, until, send, hello, messages } = await attached(t, { piEvents: true });
  const prompt = id => ({ toolCallId: id, questions: [{ question: '?', header: '', multiSelect: false, options: [{ label: 'A', description: '', hasPreview: false }] }] });
  const native = [];
  pi.events.on('rpiv:ask-user:answer', data => native.push(data));
  pi.events.emit('rpiv:ask-user:prompt', prompt('one'));
  pi.events.emit('rpiv:ask-user:prompt', prompt('two'));
  pi.events.emit('rpiv:ask-user:blocked', { toolCallId: 'two', active: false });
  const ask = (await hello()).ask;
  send({ type: 'ask_answer', requestId: ask.requestId, attemptId: 'attempt', answers: [{ id: ask.questions[0].id, selectedOptions: ['A'] }] });
  await until(() => native.length === 1);
  send({ type: 'ask_answer', requestId: ask.requestId, attemptId: 'attempt-busy', cancel: true });
  await until(() => events('ask_rejected').length === 1);
  assert.equal(events('ask_rejected')[0].code, 'busy');
  pi.events.emit('rpiv:ask-user:blocked', { toolCallId: 'one', active: false });
  pi.events.emit('rpiv:ask-user:answer-result', { ...native[0], ok: false, code: 'not_found' });
  assert.equal((await hello()).ask, null);
  assert.equal(events('ask_rejected').length, 1);
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: '' });
  assert.equal((await hello()).askWarning, true);
  pi.command('rc', 'close', ctx);
  await until(() => messages.some(m => m.event?.type === 'rc_close'));
});

test('rpiv lost verdict times out with retryable busy and late verdict cannot affect retry', async t => {
  const { pi, events, until, send, hello } = await attached(t, { piEvents: true });
  const answers = [];
  pi.events.on('rpiv:ask-user:answer', payload => answers.push(payload));
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: 'timeout', questions: [{ question: '?', header: '', multiSelect: false, options: [{ label: 'A', description: '', hasPreview: false }] }] });
  const ask = (await hello()).ask;
  const realSetTimeout = global.setTimeout;
  let expire;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 30_000) expire = fn;
    return realSetTimeout(fn, ms, ...args);
  };
  t.after(() => { global.setTimeout = realSetTimeout; });
  send({ type: 'ask_answer', requestId: ask.requestId, attemptId: 'first', cancel: true });
  await until(() => answers.length === 1);
  assert.equal(typeof expire, 'function');
  global.setTimeout = realSetTimeout;
  expire();
  await until(() => events('ask_rejected').some(e => e.attemptId === 'first'));
  assert.equal(events('ask_rejected').at(-1).code, 'busy');
  send({ type: 'ask_answer', requestId: ask.requestId, attemptId: 'second', cancel: true });
  await until(() => answers.length === 2);
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'timeout', requestId: answers[0].requestId, ok: true });
  assert.equal((await hello()).ask.requestId, ask.requestId);
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'timeout', requestId: answers[1].requestId, ok: true });
  assert.equal((await hello()).ask, null);
});

test('same-session replacement sends authenticated close before fresh hello clears warning', async t => {
  const { pi, ctx, messages, hello, until } = await attached(t, { piEvents: true });
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: '' });
  assert.equal((await hello()).askWarning, true);
  const start = messages.length;
  pi.emit('session_start', ctx);
  await until(() => messages.slice(start).some(m => m.type === 'hello'));
  const frames = messages.slice(start);
  const close = frames.findIndex(m => m.event?.type === 'rc_close');
  const fresh = frames.findIndex(m => m.type === 'hello');
  assert.ok(close >= 0 && close < fresh);
  assert.equal(frames[close].sessionId, 's1');
  assert.equal(frames[fresh].askWarning, false);
});

test('disconnected rc close replays reset after hello and restores new live mirror', async t => {
  const { pi, ctx, ws, wss, hello, until } = await attached(t, { piEvents: true });
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: '' });
  assert.equal((await hello()).askWarning, true);
  ws.terminate();
  await once(ws, 'close');
  await delay(30);
  pi.command('rc', 'close', ctx);
  const connected = once(wss, 'connection');
  pi.command('rc', '', ctx);
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: 'new', questions: [{ question: '?', header: '', multiSelect: false, options: [{ label: 'A', description: '', hasPreview: false }] }] });
  const [next] = await connected;
  const frames = [];
  next.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await until(() => frames.some(m => m.event?.type === 'ask_update'));
  const h = frames.findIndex(m => m.type === 'hello');
  const c = frames.findIndex(m => m.event?.type === 'rc_close');
  const u = frames.findIndex((m, i) => i > c && m.event?.type === 'ask_update');
  assert.ok(h >= 0 && c > h && u > c);
  assert.equal(frames[c].sessionId, frames[h].sessionId);
  assert.equal(frames[c].processId, frames[h].processId);
  assert.equal(frames[u].event.ask.kind, 'rpiv');
  assert.equal(frames[u].event.askWarning, false);
});

test('offline A switched to B then back to A resets stale warning and preserves current live state', async t => {
  const { pi, ctx, ws, wss, until, hello } = await attached(t, { omp: true });
  const a = ctx.state.id;
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: '' });
  assert.equal((await hello()).askWarning, true);
  // Model the relay's sticky warning: hello and ask_update OR the previous value.
  let relayWarning = true;
  ws.terminate();
  await once(ws, 'close');
  await delay(30);
  ctx.state.id = 's2';
  const bConnected = once(wss, 'connection');
  pi.emit('session_switch', ctx);
  const [b] = await bConnected;
  const bFrames = [];
  b.on('message', raw => bFrames.push(JSON.parse(raw.toString())));
  await until(() => bFrames.some(m => m.event?.type === 'rc_close'));
  ctx.state.id = a;
  const aConnected = once(wss, 'connection');
  pi.emit('session_switch', ctx);
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: 'new-a', questions: [{ question: '?', header: '', multiSelect: false, options: [{ label: 'A', description: '', hasPreview: false }] }] });
  const [again] = await aConnected;
  const frames = [];
  again.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await until(() => frames.some(m => m.event?.type === 'ask_update'));
  const h = frames.findIndex(m => m.type === 'hello');
  const c = frames.findIndex(m => m.event?.type === 'rc_close');
  const u = frames.findIndex((m, i) => i > c && m.event?.type === 'ask_update');
  assert.ok(h >= 0 && c > h && u > c);
  assert.equal(frames[h].sessionId, a);
  assert.equal(frames[c].processId, frames[h].processId);
  for (const frame of frames) {
    if (frame.type === 'hello') relayWarning ||= frame.askWarning;
    if (frame.event?.type === 'rc_close') relayWarning = false;
    if (frame.event?.type === 'ask_update') relayWarning ||= frame.event.askWarning;
  }
  assert.equal(relayWarning, false);
  assert.equal(frames[u].event.ask.kind, 'rpiv');
  assert.equal(frames[u].event.askWarning, false);

  // Ordinary socket loss is not a lifecycle reset: retain warning and ask.
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: '' });
  await until(() => frames.some(m => m.event?.type === 'ask_update' && m.event.askWarning));
  again.terminate();
  await once(again, 'close');
  const reconnected = once(wss, 'connection');
  const [retry] = await reconnected;
  const retryFrames = [];
  retry.on('message', raw => retryFrames.push(JSON.parse(raw.toString())));
  await until(() => retryFrames.some(m => m.type === 'hello'));
  await delay(30);
  const retryHello = retryFrames.find(m => m.type === 'hello');
  assert.equal(retryHello.askWarning, true);
  assert.equal(retryHello.ask.requestId, frames[u].event.ask.requestId);
  assert.equal(retryFrames.some(m => m.event?.type === 'rc_close'), false);
});

test('activation reset republishes a new local warning rather than clearing it', async t => {
  const { pi, ctx, wss, until } = await attached(t, { piEvents: true });
  pi.command('rc', 'close', ctx);
  const connected = once(wss, 'connection');
  pi.command('rc', '', ctx);
  pi.events.emit('rpiv:ask-user:prompt', { toolCallId: '' });
  const [ws] = await connected;
  const frames = [];
  ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
  await until(() => frames.some(m => m.event?.type === 'ask_update'));
  const h = frames.findIndex(m => m.type === 'hello');
  const c = frames.findIndex(m => m.event?.type === 'rc_close');
  const u = frames.findIndex((m, i) => i > c && m.event?.type === 'ask_update');
  assert.ok(h >= 0 && c > h && u > c);
  assert.equal(frames[h].askWarning, true);
  assert.equal(frames[u].event.askWarning, true);
});

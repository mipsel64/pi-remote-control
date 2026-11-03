const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 500; i++) { const value = fn(); if (value) return value; await delay(20); }
  throw new Error(`Timeout: ${label}`);
}
function bus() {
  const handlers = new Map();
  return { on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); return () => handlers.set(name, handlers.get(name).filter(item => item !== fn)); },
    emit(name, data) { for (const fn of handlers.get(name) || []) fn(data); } };
}
function mockPi() {
  const handlers = new Map(), commands = new Map();
  return { events: bus(), on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    registerCommand(name, command) { commands.set(name, command); },
    command(name, args, ctx) { return commands.get(name).handler(args, ctx); },
    emit(name, ctx) { for (const fn of handlers.get(name) || []) fn({ type: name }, ctx); },
    getSessionName: () => undefined, getThinkingLevel: () => 'medium', sendUserMessage() {} };
}
function context() {
  const state = { id: 'session' };
  return { state, cwd: '/work', hasUI: true, ui: { notify() {}, setStatus() {}, theme: { fg: (_, text) => text }, getEditorText: () => '', setEditorText() {} },
    sessionManager: { getSessionId: () => state.id, getBranch: () => [] }, modelRegistry: { getAvailable: () => [] },
    isIdle: () => true, getContextUsage: () => undefined, hasPendingMessages: () => false };
}

test('real relay routes rpiv attempts between browser protocol and attached extension', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prc-rpiv-'));
  const old = Object.fromEntries(['PI_RC_URL', 'PI_RC_AGENT_TOKEN'].map(k => [k, process.env[k]]));
  const sockets = []; let relay, pi, ctx;
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (pi && ctx) { pi.command('rc', 'close', ctx); pi.emit('session_shutdown', ctx); }
    if (relay && relay.exitCode === null && relay.signalCode === null) {
      const exited = once(relay, 'exit').catch(() => {}); relay.kill('SIGINT');
      await Promise.race([exited, delay(2000)]);
      if (relay.exitCode === null && relay.signalCode === null) { relay.kill('SIGKILL'); await exited; }
    }
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  process.env.PI_RC_URL = `ws://127.0.0.1:${port}/agent`; process.env.PI_RC_AGENT_TOKEN = 'e2e-agent-token';
  relay = spawn(path.resolve('server/target/debug/prc'), ['serve'], { env: { ...process.env, RC_CONFIG: path.join(dir, 'config.json'), XDG_STATE_HOME: path.join(dir, 'state'), RC_HOST: '127.0.0.1', RC_PORT: String(port), RC_PUBLIC_ORIGIN: origin, RC_AGENT_TOKEN: 'e2e-agent-token', RC_ADMIN_PASSWORD: 'e2e-password', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:e2e@localhost' }, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 500 && !ready; i++) { if (relay.exitCode !== null) throw new Error('relay exited during startup'); try { ready = (await fetch(origin)).ok; } catch {} if (!ready) await delay(20); }
  assert.ok(ready, 'relay readiness');
  const remoteControl = (await import('../extensions/remote-control.ts')).default;
  const { makeAnswerCommand, buildAnswers } = await import('../server/web/src/ask.js');
  pi = mockPi(); ctx = context(); remoteControl(pi); pi.emit('session_start', ctx); pi.command('rc', '', ctx);
  async function connect() {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'e2e-password' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`, { headers: { Origin: origin, Cookie: cookie } }); sockets.push(ws);
    const frames = []; ws.on('message', raw => frames.push(JSON.parse(raw.toString()))); await once(ws, 'open'); return { ws, frames };
  }
  const a = await connect(), b = await connect();
  const latest = () => a.frames.filter(f => f.type === 'sessions').at(-1)?.sessions?.find(session => session.sessionId === ctx.state.id);
  await until(() => latest()?.online, 'agent session');
  const prompt = id => ({ toolCallId: id, questions: [
    { question: 'First?', header: 'First', multiSelect: false, options: ['A', 'B'].map(label => ({ label, description: '', hasPreview: false })) },
    { question: 'Second?', header: 'Second', multiSelect: true, options: ['X', 'Y', 'Z'].map(label => ({ label, description: '', hasPreview: false })) },
  ] });
  const native = []; pi.events.on('rpiv:ask-user:answer', payload => native.push(payload));
  const send = (session, attempt, payload) => { const result = makeAnswerCommand(session, session.ask.requestId, attempt, payload); assert.ok(result.command, result.error); a.ws.send(result.command); };
  const rejected = frames => frames.filter(f => f.type === 'event' && f.event?.type === 'ask_rejected');
  pi.events.emit('rpiv:ask-user:prompt', prompt('tool-1'));
  const session = await until(() => latest()?.ask && latest(), 'first ask');
  const answers = buildAnswers(session.ask.questions, [{ picked: ['B'], notes: 'note one' }, { picked: ['Z', 'X'], other: true, custom: 'extra', notes: 'note two' }], true).reverse();
  send(session, 'attempt-1', { answers, globalNote: 'whole' }); await until(() => native.length === 1, 'first native answer');
  assert.match(native[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(native[0].requestId, 'attempt-1'); assert.notEqual(native[0].requestId, session.ask.requestId);
  assert.equal(native[0].toolCallId, 'tool-1'); assert.deepEqual(native[0].answers, [{ questionIndex: 0, optionIndexes: [1], notes: 'note one' }, { questionIndex: 1, optionIndexes: [0, 2], text: 'extra', notes: 'note two' }]);
  assert.equal(native[0].globalNote, 'whole'); assert.equal(native[0].cancel, undefined);
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'tool-1', requestId: native[0].requestId, ok: false, code: 'invalid_answer' });
  await until(() => rejected(a.frames).length === 1, 'rejection');
  assert.deepEqual(rejected(a.frames)[0], { type: 'event', processId: session.processId, sessionId: session.sessionId, event: { type: 'ask_rejected', requestId: session.ask.requestId, attemptId: 'attempt-1', code: 'invalid_answer' } });
  await delay(150); assert.equal(rejected(b.frames).length, 0);
  send(session, 'attempt-2', { answers, globalNote: 'whole' }); await until(() => native.length === 2, 'retry');
  assert.notEqual(native[1].requestId, native[0].requestId); assert.deepEqual(native[1].answers, native[0].answers);
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'tool-1', requestId: native[0].requestId, ok: false, code: 'invalid_answer' });
  await delay(150); assert.equal(rejected(a.frames).length, 1); assert.equal(latest().ask.requestId, session.ask.requestId);
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'tool-1', requestId: native[1].requestId, ok: true });
  await until(() => latest() && !latest().ask, 'successful clear');
  pi.events.emit('rpiv:ask-user:prompt', prompt('tool-2'));
  const second = await until(() => latest()?.ask && latest(), 'second ask');
  send(second, 'attempt-3', { cancel: true, globalNote: 'decline note' }); await until(() => native.length === 3, 'cancel');
  assert.equal(native[2].toolCallId, 'tool-2'); assert.equal(native[2].cancel, true); assert.equal(native[2].globalNote, 'decline note'); assert.equal(native[2].answers, undefined); assert.notEqual(native[2].requestId, 'attempt-3');
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'tool-2', requestId: native[2].requestId, ok: true }); await until(() => latest() && !latest().ask, 'cancel clear');
  pi.events.emit('rpiv:ask-user:prompt', prompt('tool-3')); const third = await until(() => latest()?.ask && latest(), 'third ask');
  pi.events.emit('rpiv:ask-user:blocked', { toolCallId: 'tool-3', active: false }); await until(() => latest() && !latest().ask, 'local close');
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'tool-1', requestId: native[0].requestId, ok: false, code: 'invalid_answer' });
  send(third, 'attempt-4', { cancel: true }); await until(() => rejected(a.frames).length === 2, 'stale rejection');
  assert.equal(rejected(a.frames)[1].event.code, 'not_found'); await delay(150); assert.equal(native.length, 3); assert.equal(rejected(b.frames).length, 0);

  // Keep an A attempt pending across a real Pi session replacement, then test B in flight.
  pi.events.emit('rpiv:ask-user:prompt', prompt('generation-a'));
  const generationA = await until(() => latest()?.ask && latest(), 'generation A ask');
  send(generationA, 'attempt-a', { cancel: true });
  await until(() => native.length === 4, 'generation A native attempt');
  const nativeA = native[3].requestId;
  ctx.state.id = 'session-b';
  pi.emit('session_start', ctx);
  await until(() => latest()?.online && latest().sessionId === 'session-b', 'replacement session B');
  pi.events.emit('rpiv:ask-user:prompt', prompt('generation-b'));
  const generationB = await until(() => latest()?.ask && latest(), 'generation B ask');
  assert.notEqual(generationB.processId, generationA.processId);
  send(generationB, 'attempt-b', { cancel: true });
  await until(() => native.length === 5, 'generation B native attempt');
  const nativeB = native[4].requestId;
  assert.notEqual(nativeA, nativeB);
  const aRejections = rejected(a.frames).length, bRejections = rejected(b.frames).length;
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'generation-a', requestId: nativeA, ok: true });
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'generation-a', requestId: nativeA, ok: false, code: 'invalid_answer' });
  pi.events.emit('rpiv:ask-user:blocked', { toolCallId: 'generation-a', active: false });
  await delay(150);
  assert.equal(latest().sessionId, generationB.sessionId);
  assert.equal(latest().ask.requestId, generationB.ask.requestId);
  assert.equal(rejected(a.frames).length, aRejections);
  assert.equal(rejected(b.frames).length, bRejections);
  // A second B attempt is busy, proving the original B native attempt remains pending.
  send(generationB, 'attempt-b-busy', { cancel: true });
  await until(() => rejected(a.frames).length === aRejections + 1, 'B remains busy');
  assert.equal(rejected(a.frames).at(-1).event.code, 'busy');
  assert.equal(rejected(a.frames).at(-1).event.attemptId, 'attempt-b-busy');
  assert.equal(native.length, 5);
  assert.equal(rejected(b.frames).length, bRejections);
  pi.events.emit('rpiv:ask-user:answer-result', { toolCallId: 'generation-b', requestId: nativeB, ok: true });
  await until(() => latest() && !latest().ask, 'generation B completes');
  assert.equal(rejected(a.frames).length, aRejections + 1);
});

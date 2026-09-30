import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import remoteControl from '../extensions/remote-control.ts';

const WAIT_TIMEOUT = 30_000;
const expect = playwrightExpect.configure({ timeout: WAIT_TIMEOUT });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(check, label) {
  const deadline = Date.now() + WAIT_TIMEOUT;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
async function waitGate(gate, signal) {
  if (signal?.aborted) throw new Error('aborted');
  const aborted = deferred();
  const onAbort = () => aborted.resolve();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([gate.promise, aborted.promise]);
    if (signal?.aborted) throw new Error('aborted');
  } finally { signal?.removeEventListener('abort', onAbort); }
}

// This provider never makes network requests. Pi still runs its actual agent loop,
// tool execution, extension input handlers, native queues and session events.
function controlledProvider() {
  const calls = [];
  const tools = [];
  const handled = new Set();
  let delayedInput;
  const definition = { id: 'gate', name: 'E2E gate', api: 'prc-e2e', reasoning: false,
    input: ['text'], contextWindow: 32000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  return {
    calls, tools, handled,
    delayInput(text) { delayedInput = { text, ...deferred() }; return delayedInput; },
    extension(pi) {
      pi.on('input', async event => {
        if (event.text === delayedInput?.text) await delayedInput.promise;
        return { action: handled.has(event.text) ? 'handled' : 'continue' };
      });
      pi.registerTool({ name: 'gate', label: 'Gate', description: 'Wait for the test controller',
        parameters: { type: 'object', properties: {} },
        async execute(_id, _params, signal) {
          const gate = deferred();
          tools.push(gate);
          await waitGate(gate, signal);
          return { content: [{ type: 'text', text: 'released' }], details: undefined };
        } });
      pi.registerProvider('prc-e2e', { baseUrl: 'http://127.0.0.1', api: 'prc-e2e', apiKey: 'test-only', models: [definition],
        streamSimple(model, context, options) {
          const stream = createAssistantMessageEventStream();
          const call = { ...deferred(), context, tool: false };
          calls.push(call);
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), content: [], stopReason: 'stop',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          void (async () => {
            try {
              await waitGate(call, options?.signal);
              stream.push({ type: 'start', partial: message });
              if (call.tool) {
                const block = { type: 'toolCall', id: `gate-${calls.indexOf(call)}`, name: 'gate', arguments: {} };
                message.content.push(block);
                stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
                stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message });
                message.stopReason = 'toolUse';
              } else {
                message.content.push({ type: 'text', text: '' });
                stream.push({ type: 'text_start', contentIndex: 0, partial: message });
                message.content[0].text = 'Controlled reply';
                stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Controlled reply', partial: message });
                stream.push({ type: 'text_end', contentIndex: 0, content: 'Controlled reply', partial: message });
              }
              stream.push({ type: 'done', reason: message.stopReason, message });
            } catch (error) {
              message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
              message.errorMessage = String(error);
              stream.push({ type: 'error', reason: message.stopReason, error: message });
            } finally { stream.end(); }
          })();
          return stream;
        } });
    },
  };
}

test('browser → Rust relay → extension → real Pi native steering', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prc-e2e-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const config = path.join(dir, 'config.json');
  const previous = { PI_RC_URL: process.env.PI_RC_URL, PI_RC_AGENT_TOKEN: process.env.PI_RC_AGENT_TOKEN };
  process.env.PI_RC_URL = `ws://127.0.0.1:${port}/agent`;
  process.env.PI_RC_AGENT_TOKEN = 'e2e-agent-token';
  let session, browser, relay;
  const errors = [];
  const notices = [];
  let editor = '';
  t.after(async () => {
    if (session) { await session.abort(); await session.prompt('/rc close'); session.dispose(); }
    await browser?.close();
    if (relay && relay.exitCode === null && relay.signalCode === null) { relay.kill('SIGINT'); await once(relay, 'exit'); }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  relay = spawn(path.resolve('server/target/debug/prc'), ['serve'], { env: { ...process.env,
    RC_CONFIG: config, XDG_STATE_HOME: path.join(dir, 'state'), RC_HOST: '127.0.0.1', RC_PORT: String(port),
    RC_PUBLIC_ORIGIN: origin, RC_AGENT_TOKEN: 'e2e-agent-token', RC_ADMIN_PASSWORD: 'e2e-password',
    VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: 'mailto:e2e@localhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let relayLog = '';
  relay.stdout.on('data', data => { relayLog += data; });
  relay.stderr.on('data', data => { relayLog += data; });
  await until(async () => {
    if (relay.exitCode !== null) throw new Error(relayLog);
    try { return (await fetch(origin)).ok; } catch { return false; }
  }, 'relay starts');
  const agentDir = path.join(dir, 'agent');
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, steeringMode: 'one-at-a-time' });
  const provider = controlledProvider();
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [remoteControl, provider.extension], systemPrompt: 'Isolated E2E session.' });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json') });
  ({ session } = await createAgentSession({ cwd: dir, agentDir, modelRuntime, resourceLoader: loader,
    tools: ['gate'], settingsManager, sessionManager: SessionManager.inMemory(dir), thinkingLevel: 'off' }));
  // Bind the documented SDK host UI/abort actions. This verifies editor plumbing,
  // but is deliberately not an interactive terminal renderer/keybinding test.
  await session.bindExtensions({ onError: error => errors.push(error), abortHandler: () => {
    // The SDK host mirrors interactive Stop's public clear/restore/abort operations.
    const { steering, followUp } = session.clearQueue();
    editor = [...steering, ...followUp, editor].filter(Boolean).join('\n\n');
    void session.abort();
  },
    uiContext: { notify: (...args) => notices.push(args), setStatus() {}, theme: { fg: (_color, text) => text },
      getEditorText: () => editor, setEditorText: text => { editor = text; } } });
  assert.deepEqual(errors, []);
  const model = modelRuntime.getModel('prc-e2e', 'gate');
  assert.ok(model);
  await session.setModel(model);
  await session.prompt('/rc');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(errors, []);
  browser = await chromium.launch();
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.setDefaultTimeout(WAIT_TIMEOUT);
  t.after(async () => { if (!t.passed) t.diagnostic(JSON.stringify({ relayLog, errors, notices })); });
  await page.goto(origin);
  await page.getByLabel('password', { exact: true }).fill('e2e-password');
  await page.getByRole('button', { name: 'sign in', exact: true }).click();
  await page.locator('#sessions .thread-item').click();
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const pending = page.getByRole('list', { name: 'Queued messages' }).locator('li');
  const submit = async text => {
    await page.getByLabel('Message', { exact: true }).fill(text);
    await page.locator('#send').click();
  };
  let settled = 0;
  session.subscribe(event => { if (event.type === 'agent_settled') settled++; });
  const startToolRun = async text => {
    const callIndex = provider.calls.length;
    const toolIndex = provider.tools.length;
    await submit(text);
    await until(() => provider.calls.length > callIndex, 'initial provider request');
    provider.calls[callIndex].tool = true;
    provider.calls[callIndex].resolve();
    await until(() => provider.tools.length > toolIndex, 'real gate tool running');
    return provider.tools[toolIndex];
  };

  const tool = await startToolRun('start visibility run');
  await submit('web steering one');
  await until(() => session.getSteeringMessages().length === 1, 'first native steering enqueued');
  assert.deepEqual(session.getSteeringMessages(), ['web steering one']);
  await expect(pending).toHaveText(['web steering one']);
  await submit('web steering two');
  await until(() => session.getSteeringMessages().length === 2, 'second native steering enqueued');
  assert.deepEqual(session.getSteeringMessages(), ['web steering one', 'web steering two']);
  await expect(pending).toHaveText(['web steering one', 'web steering two']);
  await page.reload();
  await expect(pending).toHaveText(['web steering one', 'web steering two']);
  // Reconnect the actual extension too; hello must include native display entries.
  await session.prompt('/rc close');
  await session.prompt('/rc');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await expect(pending).toHaveText(['web steering one', 'web steering two']);
  const before = settled;
  tool.resolve();
  await until(() => provider.calls.length === 2, 'steering consumed before next provider request');
  assert.deepEqual(session.getSteeringMessages(), ['web steering two']);
  await expect(pending).toHaveText(['web steering two']);
  assert.equal(settled, before, 'preview removed before agent settles');
  provider.calls[1].resolve();
  await until(() => provider.calls.length === 3, 'second steering consumed');
  await expect(pending).toHaveCount(0);
  assert.equal(settled, before);
  provider.calls[2].resolve();
  await session.waitForIdle();
  for (const text of ['web steering one', 'web steering two']) {
    assert.equal(session.messages.filter(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === text)).length, 1);
  }

  // Delayed input must remain visible even before native enqueue has happened.
  const delayedTool = await startToolRun('start delayed input run');
  const input = provider.delayInput('delayed steering');
  await submit('delayed steering');
  await expect(pending).toHaveText(['delayed steering']);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(session.getSteeringMessages(), []);
  await expect(pending).toHaveText(['delayed steering']);
  input.resolve();
  await until(() => session.getSteeringMessages().length === 1, 'delayed native enqueue');
  // Core dequeue/edit path: terminal uses this same public API, not a keybinding test.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(session.clearQueue(), { steering: ['delayed steering'], followUp: [] });
  await expect(pending).toHaveCount(0);
  await session.steer('edited in terminal');
  await expect(pending).toHaveCount(0); // Display is not an arbitrary terminal queue mirror.
  delayedTool.resolve();
  await until(() => provider.calls.length === 5, 'edited native input consumed');
  provider.calls[4].resolve();
  await session.waitForIdle();
  assert.equal(session.messages.filter(message => message.role === 'user' && message.content.some(block => block.text === 'edited in terminal')).length, 1);
  assert.equal(session.messages.filter(message => message.role === 'user' && message.content.some(block => block.text === 'delayed steering')).length, 0);

  const stopTool = await startToolRun('start stop run');
  await submit('stop pending');
  await until(() => session.getSteeringMessages().includes('stop pending'), 'Stop native pending');
  await expect(pending).toHaveText(['stop pending']);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(pending).toHaveCount(0);
  await session.waitForIdle();
  // Editor adapter plumbing is exercised, not actual terminal rendering/keybindings.
  assert.equal(editor, 'stop pending');
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.messages.filter(message => message.role === 'user' && message.content.some(block => block.text === 'stop pending')).length, 0);
  stopTool.resolve();

  const duplicateTool = await startToolRun('start duplicate run');
  await submit('same steering');
  await submit('same steering');
  await until(() => session.getSteeringMessages().length === 2, 'duplicate native messages');
  await expect(pending).toHaveText(['same steering', 'same steering']);
  let nextCall = provider.calls.length;
  duplicateTool.resolve();
  await until(() => provider.calls.length > nextCall, 'first duplicate consumed');
  await expect(pending).toHaveText(['same steering']);
  provider.calls[nextCall++].resolve();
  await until(() => provider.calls.length > nextCall, 'second duplicate consumed');
  await expect(pending).toHaveCount(0);
  provider.calls[nextCall].resolve();
  await session.waitForIdle();
  assert.equal(session.messages.filter(message => message.role === 'user' && message.content.some(block => block.text === 'same steering')).length, 2);

  const handledTool = await startToolRun('start handled input run');
  provider.handled.add('handled by another extension');
  await submit('handled by another extension');
  await expect(pending).toHaveText(['handled by another extension']);
  assert.deepEqual(session.getSteeringMessages(), []);
  nextCall = provider.calls.length;
  handledTool.resolve();
  await until(() => provider.calls.length > nextCall, 'handled input run continuing');
  await expect(pending).toHaveText(['handled by another extension']);
  provider.calls[nextCall].resolve();
  await session.waitForIdle();
  await expect(pending).toHaveCount(0);

  provider.handled.add('idle handled input');
  const callsBeforeIdleHandled = provider.calls.length;
  const settledBeforeIdleHandled = settled;
  await submit('idle handled input');
  await new Promise(resolve => setTimeout(resolve, 650));
  await expect(pending).toHaveCount(0);
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(provider.calls.length, callsBeforeIdleHandled, 'handled idle input starts no provider run');
  assert.equal(settled, settledBeforeIdleHandled, 'no settlement is needed to clear idle input');
  assert.deepEqual(errors, []);
  t.diagnostic('Real Chromium, Rust prc, Pi SDK 0.99.1, production extension; no provider network or fake agent socket.');
});

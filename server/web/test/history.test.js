import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildAsset, choose, contentText, folderName, initialHistory, pinFirst, needsHomeScreen, receive, sessionStatus, sessionNotice, swipeAction, unchoose, appHeight } from '../src/history.js';

const session = (sessionId = 's1', connectionId = 'c1', online = true) =>
  ({ processId: 'p1', sessionId, connectionId, name: 'Pi', cwd: '/tmp', online, busy: false });
const frame = (type, fields = {}) => ({ type, processId: 'p1', sessionId: 's1', ...fields });

test('sessions sort by latest chat update without mutating the received list', () => {
  const oldest = { ...session(), processId: 'old', updatedAt: 0 };
  const newest = { ...session(), processId: 'new', updatedAt: 1700000000200 };
  const middle = { ...session(), processId: 'mid', updatedAt: 1700000000100 };
  const sessions = [oldest, newest, middle];
  const state = receive(initialHistory, { type: 'sessions', sessions }).state;
  assert.deepEqual(state.sessions.map(item => item.processId), ['new', 'mid', 'old']);
  assert.deepEqual(sessions, [oldest, newest, middle]);
  assert.equal(state.selected, 'new');
  const updated = receive(state, { type: 'sessions', sessions: [{ ...oldest, updatedAt: 1700000000300 }, newest, middle] }).state;
  assert.deepEqual(updated.sessions.map(item => item.processId), ['old', 'new', 'mid']);
  assert.equal(updated.selected, 'new');
});

test('folder names and pinned sessions', () => {
  assert.equal(folderName('/Users/me/projects/app/'), 'app');
  assert.equal(folderName('C:\\work\\repo'), 'repo');
  assert.equal(folderName('/'), '/');
  const sessions = ['a', 'b', 'c'].map(sessionId => ({ sessionId }));
  assert.deepEqual(pinFirst(sessions, ['c']).map(item => item.sessionId), ['c', 'a', 'b']);
});

test('in-page notice only for a settled prompt the user is not looking at', () => {
  const sessions = [session(), { ...session(), processId: 'p2', name: '' }];
  const settled = (processId = 'p1') => ({ type: 'event', processId, sessionId: 's1', event: { type: 'agent_settled' } });
  const view = { enabled: true, hidden: false, selected: 'p2', sessions };
  assert.deepEqual(sessionNotice(settled(), view), { title: 'Pi', body: 'Finished responding', tag: 'p1' });
  assert.equal(sessionNotice(settled('p2'), view), null);
  assert.deepEqual(sessionNotice(settled('p2'), { ...view, hidden: true }), { title: 'New Session', body: 'Finished responding', tag: 'p2' });
  assert.equal(sessionNotice(settled(), { ...view, enabled: false }), null);
  assert.equal(sessionNotice(settled('gone'), view), null);
  assert.equal(sessionNotice({ ...settled(), event: { type: 'agent_start' } }, view), null);
  const prompt = (title) => ({ ...settled(), event: { type: 'ui_prompt_start', kind: 'confirm', title } });
  assert.equal(sessionNotice(prompt(' Allow rm? '), view).body, 'Needs your input: Allow rm?');
  assert.equal(sessionNotice(prompt(), view).body, 'Needs your input');
  assert.equal(sessionNotice({ ...settled(), event: { type: 'ui_prompt_end' } }, view), null);
  assert.equal(sessionNotice({ ...settled(), event: { type: 'agent_settled', asking: true, summary: 'Ship it?' } }, view).body, 'Ship it?');
  assert.equal(sessionNotice({ type: 'sessions', sessions }, view), null);
  const long = [{ ...session(), name: 'x'.repeat(90) }];
  assert.equal(sessionNotice(settled(), { ...view, sessions: long }).title, 'x'.repeat(80));
});

test('session status prioritizes offline over stale busy state', () => {
  assert.equal(sessionStatus({ online: true, busy: true }), 'busy');
  assert.equal(sessionStatus({ online: true, busy: false }), 'idle');
  assert.equal(sessionStatus({ online: false, busy: true }), 'offline');
  assert.equal(sessionStatus({ online: true, busy: true, waiting: true }), 'waiting');
  assert.equal(sessionStatus({ online: false, waiting: true }), 'offline');
});


test('select current process; reject stale session and refresh on replacement/reconnect', () => {
  let result = receive(initialHistory, { type: 'sessions', sessions: [session()] });
  assert.equal(result.select, 'p1');
  let state = receive(result.state, frame('snapshot', { entries: ['past'] })).state;
  assert.deepEqual(state.entries, ['past']);
  state = receive(state, frame('event', { event: { type: 'message_update', message: { role: 'assistant', content: 'typing' } } })).state;
  assert.equal(state.stream.message.content, 'typing');
  state = receive(state, frame('sessions', { sessions: [session('s2', 'c2')] })).state;
  assert.deepEqual(state.entries, []);
  assert.equal(state.stream, null);
  assert.deepEqual(receive(state, frame('snapshot', { entries: ['stale'] })).state.entries, []);
  const refreshed = receive(state, frame('snapshot', { sessionId: 's2', entries: ['new'] })).state;
  assert.deepEqual(refreshed.entries, ['new']);
  state = receive(refreshed, { type: 'sessions', sessions: [session('s2', 'c2', false)] }).state;
  assert.equal(receive(state, { type: 'sessions', sessions: [session('s2', 'c3')] }).select, 'p1');
});

test('chunk order, stale ids, broken JSON and split surrogate pairs', () => {
  const selected = receive(initialHistory, { type: 'sessions', sessions: [session()] }).state;
  const json = JSON.stringify([{ type: 'message', message: { role: 'user', content: '😀' } }]);
  const split = json.indexOf('😀') + 1;
  const chunk = (snapshotId, index, total, data) => frame('snapshot_chunk', { snapshotId, index, total, data });
  let state = receive(selected, chunk('one', 0, 2, json.slice(0, split))).state;
  assert.equal(state.pending.parts.length, 1);
  assert.equal(receive(state, chunk('other', 1, 2, json.slice(split))).state, state);
  assert.equal(receive(state, chunk('one', 1, 3, json.slice(split))).state, state);
  state = receive(state, chunk('one', 1, 2, json.slice(split))).state;
  assert.equal(state.entries[0].message.content, '😀');
  state = receive(state, chunk('bad', 0, 1, '{')).state;
  assert.equal(state.pending, null);
  assert.equal(state.entries[0].message.content, '😀');
});

test('removed sessions clear the selected transcript', () => {
  let state = receive(initialHistory, { type: 'sessions', sessions: [session()] }).state;
  state = receive(state, frame('snapshot', { entries: [{ type: 'message', message: { role: 'user', content: 'private' } }] })).state;
  state = receive(state, { type: 'sessions', sessions: [] }).state;
  assert.equal(state.selected, null);
  assert.deepEqual(state.entries, []);
  assert.equal(state.stream, null);
  assert.equal(state.pending, null);
});

test('chunked snapshots reject excessive counts and chunk sizes', () => {
  const state = receive(initialHistory, { type: 'sessions', sessions: [session()] }).state;
  const chunk = (total, data) => receive(state, frame('snapshot_chunk', { snapshotId: 'large', index: 0, total, data })).state;
  assert.equal(chunk(257, '[]').pending, null);
  assert.equal(chunk(2, 'x'.repeat(128 * 1024 + 1)).pending, null);
  assert.equal(chunk(2, 'x'.repeat(128 * 1024)).pending.size, 128 * 1024);
});

test('late streaming updates cannot revive a finished assistant message', () => {
  let state = receive(initialHistory, { type: 'sessions', sessions: [session()] }).state;
  const event = (type, timestamp, content) => frame('event', { event: { type, message: { role: 'assistant', timestamp, content } } });
  state = receive(state, event('message_start', 10, 'first')).state;
  state = receive(state, event('message_end', 10, 'done')).state;
  state = receive(state, frame('snapshot', { entries: ['done'] })).state;
  assert.equal(state.stream, null);
  assert.equal(receive(state, event('message_update', 10, 'stale')).state, state);
  state = receive(state, event('message_start', 11, 'second')).state;
  assert.equal(state.stream.message.content, 'second');
  assert.equal(receive(state, event('message_update', 10, 'stale')).state, state);
  state = receive(state, event('message_update', 11, 'live')).state;
  assert.equal(state.stream.message.content, 'live');
});

test('snapshot does not erase live output received during reconnect', () => {
  let state = receive(initialHistory, { type: 'sessions', sessions: [session()] }).state;
  state = receive(state, { type: 'sessions', sessions: [session('s1', 'c2')] }).state;
  assert.equal(state.awaiting, true);
  state = receive(state, frame('event', { event: { type: 'message_update', message: { role: 'assistant', timestamp: 12, content: 'new output' } } })).state;
  state = receive(state, frame('snapshot', { entries: ['old history'] })).state;
  assert.equal(state.stream.message.content, 'new output');
  assert.equal(state.awaiting, false);
});

test('end without a timestamp does not erase the completed-message watermark', () => {
  let state = receive(initialHistory, { type: 'sessions', sessions: [session()] }).state;
  state = receive(state, frame('event', { event: { type: 'message_end', message: { role: 'assistant', timestamp: 10, content: 'done' } } })).state;
  state = receive(state, frame('event', { event: { type: 'message_end', message: { role: 'assistant', content: 'unknown' } } })).state;
  assert.equal(state.lastEndedAt, 10);
  state = receive(state, frame('snapshot', { entries: ['done'] })).state;
  assert.equal(receive(state, frame('event', { event: { type: 'message_start', message: { role: 'assistant', timestamp: 9, content: 'stale' } } })).state, state);
});

test('service worker shows the server title and body, ignores unknown fields, and never intercepts API requests', async () => {
  const listeners = {};
  const notifications = [];
  const self = {
    location: { origin: 'https://example.test' },
    addEventListener(type, handler) { listeners[type] = handler; },
    registration: { async showNotification(...args) { notifications.push(args); } }
  };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, fetch: async () => ({ ok: false }) });
  const push = async data => {
    let pending;
    listeners.push({ data, waitUntil(promise) { pending = promise; } });
    await pending;
    return JSON.parse(JSON.stringify(notifications.at(-1)));
  };
  const payload = { title: 'T'.repeat(150), body: 'B'.repeat(250), processId: 'p1', sessionId: 's1', transcript: 'secret' };
  assert.deepEqual(await push({ json: () => payload }),
    ['T'.repeat(100), { body: 'B'.repeat(200), icon: '/icon-192.png', tag: 'p1', data: { processId: 'p1' } }]);
  assert.doesNotMatch(JSON.stringify(notifications), /secret/);
  const generic = ['Pi Remote Control', { body: 'Session ready', icon: '/icon-192.png', data: {} }];
  assert.deepEqual(await push({ json: () => { throw new SyntaxError('bad'); } }), generic);
  assert.deepEqual(await push(null), generic);
  assert.deepEqual(await push({ json: () => ({ title: 7, body: ['x'], processId: {} }) }), generic);
  let intercepted = false;
  listeners.fetch({ request: { method: 'GET', url: 'https://example.test/api/push-key' }, respondWith() { intercepted = true; } });
  listeners.fetch({ request: { method: 'GET', url: 'https://example.test/icon.svg' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, true);
  intercepted = false;
  listeners.fetch({ request: { method: 'GET', url: 'https://example.test/api/push-key' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
});

test('service worker returns cached shell offline, a 503 on miss, and reuses the open tab', async () => {
  const listeners = {};
  let windows = [{ url: 'https://example.test/', focus: async () => 'focused' }];
  let opened = 0;
  const self = {
    location: { origin: 'https://example.test' },
    addEventListener(type, handler) { listeners[type] = handler; },
    clients: { matchAll: async () => windows, openWindow: async () => { opened++; return 'opened'; } }
  };
  const cached = new Response('cached');
  const caches = { match: async key => { assert.ok(key === '/' || key === '/icon.svg'); return windows.length ? cached : undefined; } };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self, caches, URL, Response, fetch: async () => { throw new Error('offline'); }
  });
  let pending;
  const request = url => ({ method: 'GET', url });
  listeners.fetch({ request: request('https://example.test/?source=home'), respondWith(promise) { pending = promise; } });
  assert.equal(await pending, cached);
  let click;
  listeners.notificationclick({ notification: { close() {} }, waitUntil(promise) { click = promise; } });
  assert.equal(await click, 'focused');
  assert.equal(opened, 0);
  windows = [];
  listeners.fetch({ request: request('https://example.test/icon.svg'), respondWith(promise) { pending = promise; } });
  assert.equal((await pending).status, 503);
  let intercepted = false;
  listeners.fetch({ request: request('https://example.test/assets/missing.js'), respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
  listeners.notificationclick({ notification: { close() {} }, waitUntil(promise) { click = promise; } });
  assert.equal(await click, 'opened');
  assert.equal(opened, 1);
});

test('service worker notification click opens the finished session', async () => {
  const listeners = {};
  const messages = [];
  const urls = [];
  let windows = [{ url: 'https://other.test/', postMessage() { throw new Error('wrong origin'); } },
    { url: 'https://example.test/', postMessage(message) { messages.push(message); }, focus: async () => 'focused' }];
  const self = {
    location: { origin: 'https://example.test' },
    addEventListener(type, handler) { listeners[type] = handler; },
    clients: { matchAll: async () => windows, openWindow: async url => { urls.push(url); return 'opened'; } }
  };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL });
  const click = async processId => {
    let pending;
    listeners.notificationclick({ notification: { close() {}, data: { processId } }, waitUntil(promise) { pending = promise; } });
    return pending;
  };
  assert.equal(await click('p/1'), 'focused');
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'open-session', processId: 'p/1' }]);
  windows = [];
  assert.equal(await click('p/1'), 'opened');
  assert.deepEqual(urls, ['/?session=p%2F1']);
});

test('service worker keeps a successful response even when cache writes fail', async () => {
  const listeners = {};
  const self = { location: { origin: 'https://example.test' }, addEventListener(type, handler) { listeners[type] = handler; } };
  const response = new Response('online');
  const caches = { open: async () => ({ put: async key => { assert.equal(key, '/icon.svg'); throw new Error('quota'); } }) };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, caches, URL, Response, fetch: async () => response });
  let pending;
  listeners.fetch({ request: { method: 'GET', url: 'https://example.test/icon.svg?v=1' }, respondWith(promise) { pending = promise; } });
  assert.equal(await pending, response);
});

test('optional icons cannot block a successful app-shell install', async () => {
  const listeners = {};
  let installed = false;
  const self = { addEventListener(type, handler) { listeners[type] = handler; }, skipWaiting() { installed = true; } };
  const caches = { open: async () => ({
    addAll: async paths => assert.deepEqual([...paths], ['/']),
    add: async () => { throw new Error('optional icon unavailable'); }
  }) };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, caches, URL });
  let pending;
  listeners.install({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert.equal(installed, true);
});

test('built service worker precaches the app shell on first installation', async () => {
  const assets = readdirSync(new URL('../dist/assets/', import.meta.url)).map(name => `/assets/${name}`);
  const index = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8');
  const listeners = {};
  let cached;
  const self = {
    addEventListener(type, handler) { listeners[type] = handler; },
    skipWaiting() { return Promise.resolve(); }
  };
  const caches = { open() { return Promise.resolve({ addAll(paths) { cached = paths; return Promise.resolve(); }, add: async () => {} }); } };
  runInNewContext(worker, { self, caches, URL });
  let pending;
  listeners.install({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert.ok(cached.includes('/'));
  for (const asset of assets) assert.ok(cached.includes(asset), `Missing ${asset}`);
  for (const [, asset] of index.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) assert.ok(cached.includes(asset));
  assert.match(worker, /pi-remote-shell-[0-9a-f]{12}/);
});

test('untrusted message text remains text and image data is omitted', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  assert.equal(contentText([{ type: 'text', text: hostile }, { type: 'image', data: 'private-base64' }]), `${hostile}\n[image]`);
});

test('offline sessions are selected so the server can replay their stored snapshot', () => {
  const result = receive(initialHistory, { type: 'sessions', sessions: [session('s1', 'c1', false)] });
  assert.equal(result.select, 'p1');
  assert.equal(receive(result.state, frame('snapshot', { entries: ['saved'] })).state.entries[0], 'saved');
});

test('transcript stays readable after disconnect and follows a resumed session to its new process', () => {
  let state = receive(initialHistory, { type: 'sessions', sessions: [session()] }).state;
  state = receive(state, frame('snapshot', { entries: ['kept'] })).state;
  let result = receive(state, { type: 'sessions', sessions: [session('s1', 'c1', false)] });
  assert.equal(result.select, null);
  assert.deepEqual(result.state.entries, ['kept']);
  const other = { ...session('s9', 'c9'), processId: 'p9', updatedAt: 5 };
  const resumed = { ...session('s1', 'c2'), processId: 'p2', updatedAt: 1 };
  result = receive(result.state, { type: 'sessions', sessions: [other, resumed] });
  assert.equal(result.select, 'p2');
  assert.equal(result.state.selected, 'p2');
  assert.deepEqual(result.state.entries, ['kept']);
  assert.equal(receive(result.state, frame('snapshot', { processId: 'p2', entries: ['fresh'] })).state.entries[0], 'fresh');
  result = receive(result.state, { type: 'sessions', sessions: [other] });
  assert.equal(result.select, 'p9');
  assert.deepEqual(result.state.entries, []);
});

test('buildAsset finds the built entry script so a stale tab can detect a new server build', () => {
  const built = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(buildAsset(built), /^\/assets\/index-[\w-]+\.js$/);
  assert.equal(buildAsset('<script type="module" src="/src/main.jsx"></script>'), null);
  assert.equal(buildAsset(undefined), null);
});

test('models are cached per process and optimistic picks last until that process changes', () => {
  const other = { ...session('s9', 'c9'), processId: 'p9' };
  let state = receive(initialHistory, { type: 'sessions', sessions: [session(), other] }).state;
  const models = [{ provider: 'openai', id: 'mini', name: 'Mini', reasoning: false }];
  assert.equal(receive(state, frame('models', { sessionId: 'stale', models })).state, state);
  assert.equal(receive(state, frame('models', { processId: 'unknown', models })).state, state);
  state = receive(state, frame('models', { processId: 'p9', sessionId: 's9', models })).state;
  assert.deepEqual(state.models, { p9: models });
  const refreshed = [{ provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true }];
  assert.deepEqual(receive(state, frame('models', { processId: 'p9', sessionId: 's9', models: refreshed })).state.models, { p9: refreshed });
  state = choose(state, 'p1', { model: 'openai\u0000mini' });
  state = choose(state, 'p1', { thinkingLevel: 'high' });
  assert.deepEqual(state.optimistic.p1, { model: 'openai\u0000mini', thinkingLevel: 'high' });
  state = receive(state, { type: 'sessions', sessions: [session(), { ...other, busy: true }] }).state;
  assert.deepEqual(state.optimistic.p1, { model: 'openai\u0000mini', thinkingLevel: 'high' });
  state = receive(state, { type: 'sessions', sessions: [{ ...session(), thinkingLevel: 'high' }, other] }).state;
  assert.deepEqual(state.optimistic, {});
  assert.deepEqual(state.models, { p9: models });
  state = receive(choose(state, 'p9', { thinkingLevel: 'low' }), { type: 'sessions', sessions: [session()] }).state;
  assert.deepEqual(state.optimistic, {});
  const refused = choose(state, 'p1', { model: 'openai\u0000mini' });
  const stalePick = refused.optimistic.p1;
  assert.deepEqual(unchoose(refused, 'p1', stalePick).optimistic, {});
  const newer = choose(refused, 'p1', { thinkingLevel: 'low' });
  assert.equal(unchoose(newer, 'p1', stalePick), newer);
});

test('needsHomeScreen explains missing iPhone/iPad notifications only outside a Home Screen app', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(needsHomeScreen({ userAgent: iphone }), true);
  assert.equal(needsHomeScreen({ userAgent: iphone, standalone: true }), false);
  assert.equal(needsHomeScreen({ userAgent: iphone, canNotify: true }), false);
  assert.equal(needsHomeScreen({ userAgent: iphone, secure: false }), false);
  assert.equal(needsHomeScreen({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(needsHomeScreen({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(needsHomeScreen({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile' }), false);
});

test('swipeAction opens the drawer on a right swipe and closes it on a left swipe', () => {
  const swipe = (dx, dy, open) => swipeAction({ startX: 100, startY: 300, endX: 100 + dx, endY: 300 + dy, open });
  assert.equal(swipe(80, 10, false), 'open');
  assert.equal(swipe(-80, 10, true), 'close');
  assert.equal(swipe(80, 10, true), null);
  assert.equal(swipe(-80, 10, false), null);
  assert.equal(swipe(40, 0, false), null);
  assert.equal(swipe(80, 60, false), null);
});

test('appHeight follows the area above the keyboard and ignores pinch-zoom', () => {
  assert.equal(appHeight({ height: 844, scale: 1 }), '844px');
  assert.equal(appHeight({ height: 503.6, scale: 1 }), '504px');
  assert.equal(appHeight({ height: 400, scale: 2 }), null);
});

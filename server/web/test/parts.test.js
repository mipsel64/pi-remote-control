import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildThread, groupModels, levelLabel, matchModel, modelKey, modelOption, modelPicker, modelTrigger, normalizeParts, relativeTime, splitModelKey, toolStatus, toolSummary, usageSummary } from '../src/parts.js';
import { Markdown } from '../src/markdown.js';

const message = message => ({ type: 'message', message });

test('buildThread pairs tool results with their calls and keeps unmatched results standalone', () => {
  const items = buildThread([
    message({ role: 'user', content: 'list files' }),
    message({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }] }),
    message({ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }], isError: false }),
    message({ role: 'toolResult', toolCallId: 'orphan', toolName: 'read', content: 'x', isError: true })
  ]);
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistant', 'tool']);
  assert.deepEqual(items[1].parts.map(part => part.type), ['thinking', 'text', 'toolCall']);
  assert.equal(items[1].parts[2].result.content[0].text, 'a.txt');
  assert.equal(items[2].call.name, 'read');
  assert.equal(toolStatus(items[2].call.result, false), 'error');
});

test('buildThread pairs a streamed tool call and marks the live message', () => {
  const stream = { message: { role: 'assistant', content: [{ type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'a' } }] }, ended: false };
  const items = buildThread([message({ role: 'toolResult', toolCallId: 't2', content: [] })], stream);
  assert.equal(items.length, 1);
  assert.equal(items[0].streaming, true);
  assert.ok(items[0].parts[0].result);
  assert.equal(buildThread([], { ...stream, ended: true })[0].streaming, false);
});

test('buildThread maps special roles and degrades unknown shapes to text', () => {
  const items = buildThread([
    null, 'junk', { type: 'message' }, { type: 'model_change' },
    message({ role: 'bashExecution', command: 'pwd', output: '/tmp', exitCode: 1 }),
    message({ role: 'compactionSummary', summary: 'short' }),
    message({ role: 'branchSummary', summary: 'branch' }),
    message({ role: 'custom', customType: 'note', content: 'hidden', display: false }),
    { type: 'custom_message', customType: 'plan', content: [{ type: 'text', text: 'step' }], display: true },
    { type: 'custom_message', customType: 'secret', content: 'nope', display: false },
    message({ role: 'mystery', content: 42, text: 'fallback' }),
    message({ content: [{ type: 'weird', text: 'still text' }, { type: 'weird' }, 7] }),
    message({ role: 'assistant', content: [{ type: 'image', data: 'private-base64' }, { type: 'odd', text: 'kept' }], errorMessage: 'boom' })
  ]);
  assert.deepEqual(items.map(item => item.kind), ['bash', 'summary', 'summary', 'custom', 'custom', 'custom', 'assistant']);
  assert.deepEqual([items[0].command, items[0].output, items[0].exitCode], ['pwd', '/tmp', 1]);
  assert.equal(items[1].label, 'Context compacted');
  assert.equal(items[2].label, 'Branch summarized');
  assert.deepEqual([items[3].label, items[3].text], ['plan', 'step']);
  assert.deepEqual([items[4].label, items[4].text], ['mystery', 'fallback']);
  assert.deepEqual([items[5].label, items[5].text], ['message', 'still text']);
  assert.deepEqual(items[6].parts, [{ type: 'image' }, { type: 'text', text: 'kept' }]);
  assert.equal(items[6].error, 'boom');
  assert.doesNotMatch(JSON.stringify(items), /private-base64/);
  assert.deepEqual(normalizeParts({ not: 'content' }), []);
  assert.deepEqual(buildThread(undefined, null), []);
});

test('buildThread gives extension messages a one-line summary', () => {
  const [event, note, plain] = buildThread([
    { type: 'custom_message', customType: 'ad-process:notification', display: true,
      content: '<process_event>\n  <summary>Process "x" ended.</summary>\n  <exit_code>0</exit_code>\n</process_event>' },
    { type: 'custom_message', customType: 'reminder', display: true, content: 'Run tests.\nThen build.' },
    { type: 'custom_message', customType: 'plan', display: true, content: ' step ' }
  ]);
  assert.deepEqual([event.label, event.summary], ['ad-process:notification', 'Process "x" ended.']);
  assert.match(event.text, /<exit_code>0<\/exit_code>/);
  assert.equal(note.summary, 'Run tests.');
  assert.equal(plain.summary, 'step');
});

test('buildThread renders raw Pi compaction and branch-summary entries', () => {
  const items = buildThread([{ type: 'compaction', summary: 'earlier work' }, { type: 'branch_summary', summary: 'other path' }, { type: 'label', label: 'x' }]);
  assert.deepEqual(items.map(item => [item.kind, item.label, item.text]),
    [['summary', 'Context compacted', 'earlier work'], ['summary', 'Branch summarized', 'other path']]);
});

test('toolSummary picks the first useful argument and summarizes task tools', () => {
  assert.equal(toolSummary('bash', { command: 'npm test\nsecond line' }), 'npm test');
  assert.equal(toolSummary('read', { path: 'src/a.js', limit: 3 }), 'src/a.js');
  assert.equal(toolSummary('edit', { file_path: 'b.rs' }), 'b.rs');
  assert.equal(toolSummary('web_search', { query: 'rust' }), 'rust');
  assert.equal(toolSummary('fetch', { url: 'https://x.test' }), 'https://x.test');
  assert.equal(toolSummary('grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(toolSummary('TaskCreate', { subject: 'Ship UI', description: 'long' }), 'Ship UI');
  assert.equal(toolSummary('TaskUpdate', { taskId: 3, status: 'completed' }), '#3 · completed');
  assert.equal(toolSummary('x', 'raw args'), 'raw args');
  assert.equal(toolSummary('x', { other: 1 }), '');
  assert.equal(toolSummary('x', null), '');
  assert.equal(toolSummary('bash', { command: 'y'.repeat(200) }).length, 120);
  assert.equal(toolStatus(undefined, true), 'pending');
  assert.equal(toolStatus(undefined, false), 'incomplete');
  assert.equal(toolStatus({ isError: false }, true), 'done');
});

test('Markdown renders GFM, keeps raw HTML inert, and never loads remote images', () => {
  const html = text => renderToStaticMarkup(createElement(Markdown, { text }));
  assert.match(html('**Pi Remote Control** and _it_ ~~old~~'), /<strong>Pi Remote Control<\/strong> and <em>it<\/em> <del>old<\/del>/);
  assert.match(html('- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'), /<ul>[\s\S]*<li>one<\/li>[\s\S]*<table>/);
  assert.match(html('```js\nconst a = 1;\n```'), /code-lang">js<\/div><pre><code class="language-js">const a = 1;/);
  assert.match(html('```\nstill streaming'), /<pre><code>still streaming/);
  const unsafe = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) ![pixel](https://tracker.example/p.png)');
  assert.doesNotMatch(unsafe, /<script|<img|href="javascript/);
  assert.match(unsafe, /&lt;script&gt;/);
  assert.match(unsafe, /<a href="https:\/\/tracker.example\/p.png" target="_blank" rel="noopener noreferrer">pixel<\/a>/);
  assert.equal(html(undefined), '<div class="md"></div>');
  const footnote = html('See[^1].\n\n[^1]: Note.');
  assert.match(footnote, /<a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref="true" aria-describedby="footnote-label">1<\/a>/);
  assert.doesNotMatch(footnote, /href="#[^"]*" [^>]*target=/);
});

test('buildThread hides Pi system-prompt messages', () => {
  const items = buildThread([message({ role: 'system', content: '', sections: { preamble: 'You are...' } }), message({ role: 'user', content: 'hi' })]);
  assert.deepEqual(items.map(item => item.kind), ['user']);
});

test('relativeTime', () => {
  const now = 10 * 86400000;
  assert.equal(relativeTime(now - 30000, now), 'now');
  assert.equal(relativeTime(now - 5 * 60000, now), '5m');
  assert.equal(relativeTime(now - 3 * 3600000, now), '3h');
  assert.equal(relativeTime(now - 2 * 86400000, now), '2d');
  assert.equal(relativeTime(0, now), '');
  assert.equal(relativeTime(undefined, now), '');
});

test('model keys round-trip, options show route names and subtitles, and group by route in list order', () => {
  const key = modelKey({ provider: 'openrouter', id: 'anthropic/claude:beta' });
  assert.deepEqual(splitModelKey(key), { provider: 'openrouter', modelId: 'anthropic/claude:beta' });
  assert.deepEqual(splitModelKey(modelKey({ provider: 'a', id: 'b\u0000c' })), { provider: 'a', modelId: 'b\u0000c' });
  assert.deepEqual(modelOption({ provider: 'tinyllm', id: 'openrouter/openai/gpt-5', name: 'GPT-5' }),
    { value: 'tinyllm\u0000openrouter/openai/gpt-5', id: 'openrouter/openai/gpt-5', provider: 'tinyllm', route: 'openrouter', name: 'GPT-5', label: '(openrouter) openai/gpt-5', subtitle: 'openrouter · via tinyllm' });
  assert.deepEqual(modelOption({ provider: 'anthropic', id: 'sonnet', name: '' }),
    { value: 'anthropic\u0000sonnet', id: 'sonnet', provider: 'anthropic', route: 'anthropic', name: 'sonnet', label: 'sonnet', subtitle: 'anthropic' });
  assert.equal(modelOption({ provider: 'tinyllm', id: 'codex/gpt-5.1' }).name, 'gpt-5.1');
  const groups = groupModels([
    { provider: 'openai', id: 'mini', name: 'Mini' },
    { provider: 'tinyllm', id: 'openrouter/openai/gpt-5', name: 'GPT-5' },
    { provider: 'openai', id: 'big', name: 'Big' },
    { provider: 'tinyllm', id: 'codex/gpt-5.1' },
    { provider: 'openrouter', id: 'anthropic/claude', name: 'Claude' }
  ].map(modelOption));
  assert.deepEqual(groups.map(group => [group.provider, group.options.map(option => option.label)]),
    [['openai', ['mini', 'big']], ['tinyllm', ['(openrouter) openai/gpt-5', '(codex) gpt-5.1']], ['openrouter', ['(anthropic) claude']]]);
});

test('matchModel filters by name, id, route, and provider case-insensitively', () => {
  const option = modelOption({ provider: 'tinyllm', id: 'openrouter/openai/gpt-5', name: 'GPT-5' });
  for (const query of ['', '  ', 'gpt', 'OPENAI/GPT', 'Router', 'tiny']) assert.equal(matchModel(option, query), true, query);
  assert.equal(matchModel(option, 'claude'), false);
});

test('levelLabel names thinking levels and passes unknown ones through', () => {
  assert.deepEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'turbo'].map(levelLabel),
    ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'turbo']);
});

test('modelPicker shows server values, optimistic picks, effort visibility, and read-only offline names', () => {
  const current = { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true, thinkingLevels: ['off', 'low', 'high'] };
  const models = [{ provider: 'openai', id: 'mini', name: 'Mini', reasoning: false }];
  const online = { online: true, model: current, thinkingLevel: 'low' };
  assert.equal(modelPicker(undefined, models), null);
  const picker = modelPicker(online, models);
  assert.deepEqual([picker.value, picker.model.name, picker.level, picker.levels, picker.hasEffort], ['anthropic\u0000sonnet', 'Sonnet', 'low', ['off', 'low', 'high'], true]);
  assert.deepEqual(picker.options.map(option => option.value), ['anthropic\u0000sonnet', 'openai\u0000mini']);
  const chosen = modelPicker(online, models, { model: 'openai\u0000mini', thinkingLevel: 'high' });
  assert.deepEqual([chosen.value, chosen.model.name, chosen.level], ['openai\u0000mini', 'Mini', 'high']);
  assert.deepEqual([chosen.levels, chosen.hasEffort], [[], false]);
  assert.equal(modelPicker(online, models, { model: 'anthropic\u0000sonnet' }).hasEffort, true);
  const unlisted = modelPicker(online, undefined);
  assert.deepEqual([unlisted.options, unlisted.model.name], [null, 'Sonnet']);
  const offline = modelPicker({ ...online, online: false }, models);
  assert.deepEqual([offline.options, offline.model.name, offline.levels, offline.hasEffort], [null, 'Sonnet', [], false]);
  assert.equal(modelPicker({ online: false, model: null }, models).model, null);
  assert.equal(modelPicker({ ...online, model: { ...current, thinkingLevels: ['off'] } }, models).hasEffort, false);
});

test('modelTrigger shows name with effort only when selectable and a descriptive label', () => {
  const gpt = { provider: 'openai', id: 'gpt-5', name: 'GPT-5', thinkingLevels: ['low', 'high', 'xhigh'] };
  assert.deepEqual(modelTrigger(modelPicker({ online: true, model: gpt, thinkingLevel: 'high' }, [])),
    { name: 'GPT-5', effort: 'high', label: 'Model: GPT-5 (openai), effort: high' });
  assert.equal(modelTrigger(modelPicker({ online: true, model: gpt, thinkingLevel: 'xhigh' }, [])).label, 'Model: GPT-5 (openai), effort: extra high');
  const routed = { provider: 'tinyllm', id: 'openrouter/openai/gpt-5', name: 'GPT-5', thinkingLevels: ['off'] };
  assert.deepEqual(modelTrigger(modelPicker({ online: true, model: routed, thinkingLevel: 'off' }, [])),
    { name: 'GPT-5', effort: '', label: 'Model: GPT-5 (openrouter)' });
  assert.deepEqual(modelTrigger(modelPicker({ online: true, model: null }, [])), { name: 'Select model', effort: '', label: 'Select model' });
});

test('usageSummary totals every reply and gauges the agent-reported context', () => {
  const reply = usage => message({ role: 'assistant', content: [], stopReason: 'stop', usage });
  const entries = [reply({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }),
    reply({ input: 2000, output: 1000, cacheRead: 47000, cacheWrite: 0, cost: { total: 0.02 } })];
  assert.deepEqual(usageSummary(entries, { tokens: 50000, contextWindow: 200000 }),
    { text: '25.0%/200k · $0.030', title: 'Context 50k of 200k · ↑3k ↓1.5k R47k W0 · $0.0300' });
  assert.equal(usageSummary(entries, { tokens: null, contextWindow: 200000 }).text, '?%/200k · $0.030');
  assert.equal(usageSummary(entries).text, '$0.030');
  assert.equal(usageSummary([], { tokens: 0, contextWindow: 1000000 }).text, '0.0%/1M');
  assert.equal(usageSummary([message({ role: 'user', content: 'hi' })]), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLANK_ANSWER, isAnswered, requestKey, visibleAsk, buildAnswers, reconcileDrafts, rejectionMatches, makeAnswerCommand } from '../src/ask.js';

const session = { processId: 'p', sessionId: 's', connectionId: 'c', online: true, ask: { kind: 'rpiv', requestId: 'r' } };
const command = payload => makeAnswerCommand(session, 'r', 'a', payload);

test('UTF-8 note and custom answer limits include 16 KiB exactly', () => {
  for (const field of ['notes', 'customInput']) {
    assert.ok(command({ answers: [{ id: 'q', selectedOptions: [], [field]: 'é'.repeat(8192) }] }).command);
    assert.ok(command({ answers: [{ id: 'q', selectedOptions: [], [field]: 'é'.repeat(8192) + 'x' }] }).error);
  }
  assert.ok(command({ cancel: true, globalNote: '😀'.repeat(4096) }).command);
  assert.ok(command({ cancel: true, globalNote: '😀'.repeat(4096) + 'x' }).error);
});

test('serialized full envelope respects the exact 64 KiB boundary', () => {
  const payload = { answers: Array.from({ length: 5 }, (_, i) => ({ id: String(i), selectedOptions: [], notes: '' })) };
  const base = new TextEncoder().encode(command(payload).command).length;
  let remaining = 65536 - base;
  for (const answer of payload.answers) { const n = Math.min(remaining, 16384); answer.notes = 'x'.repeat(n); remaining -= n; }
  assert.equal(remaining, 0);
  assert.equal(new TextEncoder().encode(command(payload).command).length, 65536);
  payload.answers[4].notes += 'x';
  assert.match(command(payload).error, /64 KiB/);
});

test('cancel drops answers and includes only optional global note', () => {
  const parsed = JSON.parse(command({ cancel: true, answers: [{ id: 'q' }], globalNote: 'note' }).command);
  assert.equal(parsed.cancel, true); assert.equal(parsed.globalNote, 'note'); assert.equal('answers' in parsed, false);
  assert.equal('globalNote' in JSON.parse(command({ cancel: true }).command), false);
});

test('empty multi is permitted only for omp and custom text remains exact for rpiv', () => {
  const question = { id: 'q', multi: true, options: [{ label: 'a' }] };
  assert.equal(isAnswered(question, BLANK_ANSWER, false), true);
  assert.equal(isAnswered(question, BLANK_ANSWER, true), false);
  assert.equal(isAnswered(question, { ...BLANK_ANSWER, other: true, custom: '  ' }, true), false);
  assert.deepEqual(buildAnswers([question], { 0: { picked: ['a'], other: true, custom: '  text  ', notes: 'n' } }, true), [{ id: 'q', selectedOptions: ['a'], customInput: '  text  ', notes: 'n' }]);
});

test('unknown kind is rejected and terminal only needs no questions', () => {
  assert.equal(visibleAsk({ kind: 'future', requestId: 'r', questions: [{}] }), null);
  assert.equal(visibleAsk({ kind: 'terminal_only', requestId: 'r', reason: 'preview' }).reason, 'preview');
  assert.ok(visibleAsk({ requestId: 'r', questions: [{}] }));
});

test('only the exact rejection tuple matches, including the current attempt', () => {
  const waiting = { processId: 'p', sessionId: 's', requestId: 'r', attemptId: 'new' };
  const message = { type: 'event', processId: 'p', sessionId: 's', event: { type: 'ask_rejected', requestId: 'r', attemptId: 'new' } };
  assert.equal(rejectionMatches(waiting, message), true);
  for (const altered of [{ ...message, processId: 'other' }, { ...message, sessionId: 'other' }, { ...message, event: { ...message.event, requestId: 'other' } }, { ...message, event: { ...message.event, attemptId: 'old' } }]) assert.equal(rejectionMatches(waiting, altered), false);
});

test('drafts survive selection and offline snapshots but prune on close, replacement or removal', () => {
  const other = { ...session, processId: 'p2', ask: { kind: 'rpiv', requestId: 'r2' } };
  const k1 = requestKey(session, session.ask), k2 = requestKey(other, other.ask);
  const drafts = { [k1]: { answers: { 0: { custom: 'one' } }, globalNote: 'saved' }, [k2]: { answers: { 0: { custom: 'two' } }, waiting: { connectionId: 'c' } } };
  assert.deepEqual(reconcileDrafts(drafts, [other, session]), drafts);
  assert.deepEqual(reconcileDrafts(drafts, [session, { ...other, online: false, ask: null }]), drafts);
  assert.deepEqual(reconcileDrafts(drafts, [session, { ...other, connectionId: 'new' }])[k2].waiting, null);
  assert.deepEqual(Object.keys(reconcileDrafts(drafts, [session, { ...other, ask: null }])), [k1]);
  assert.deepEqual(Object.keys(reconcileDrafts(drafts, [session, { ...other, ask: { requestId: 'next' } }])), [k1]);
  assert.deepEqual(Object.keys(reconcileDrafts(drafts, [other])), [k2]);
});

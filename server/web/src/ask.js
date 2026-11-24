export const BLANK_ANSWER = { picked: [], other: false, custom: '' };
export const isAnswered = (question, { picked, other, custom }, rpiv) => (!other || custom.trim() !== '') && (rpiv ? picked.length > 0 || other : question.multi || picked.length > 0 || other);
export const requestKey = (session, ask) => JSON.stringify([session.processId, session.sessionId, ask.requestId]);

export function visibleAsk(ask) {
  if (typeof ask?.requestId !== 'string' || !ask.requestId || ![undefined, 'omp', 'rpiv', 'terminal_only'].includes(ask.kind)) return null;
  if (ask.kind === 'terminal_only') return ask;
  if (!Array.isArray(ask.questions) || !ask.questions.length) return null;
  return { ...ask, questions: ask.questions.map(question => ({
    id: question?.id,
    header: typeof question?.header === 'string' ? question.header : '',
    question: String(question?.question ?? ''),
    multi: question?.multi === true,
    recommended: Number.isInteger(question?.recommended) ? question.recommended : -1,
    options: (Array.isArray(question?.options) ? question.options : []).filter(option => typeof option?.label === 'string')
      .map(option => ({ label: option.label, description: typeof option.description === 'string' ? option.description : '' })),
  })) };
}

export function buildAnswers(questions, answers, rpiv) {
  return questions.map((question, index) => {
    const { picked, other, custom } = { ...BLANK_ANSWER, ...answers[index] };
    const selectedOptions = [...new Set(question.options.map(option => option.label))].filter(label => picked.includes(label));
    const customInput = other ? (rpiv ? custom : custom.trim()) : '';
    const result = customInput ? { id: question.id, selectedOptions, customInput } : { id: question.id, selectedOptions };
    if (rpiv && answers[index]?.notes) result.notes = answers[index].notes;
    return result;
  });
}

// Keep at most one draft per extant session's current request. Offline snapshots omit asks,
// so retain their drafts until a subsequent online snapshot or explicit close arrives.
export function reconcileDrafts(drafts, sessions) {
  const live = new Map(sessions.map(session => [JSON.stringify([session.processId, session.sessionId]), session]));
  return Object.fromEntries(Object.entries(drafts).flatMap(([key, draft]) => {
    const [processId, sessionId, requestId] = JSON.parse(key);
    const session = live.get(JSON.stringify([processId, sessionId]));
    if (!session || (session.online && session.ask?.requestId !== requestId)) return [];
    if (draft.waiting && session.connectionId !== draft.waiting.connectionId)
      return [[key, { ...draft, waiting: null }]];
    return [[key, draft]];
  }));
}

export function rejectionMatches(waiting, message) {
  const event = message.event;
  return Boolean(waiting?.attemptId && message.type === 'event' && event?.type === 'ask_rejected' &&
    waiting.processId === message.processId && waiting.sessionId === message.sessionId &&
    waiting.requestId === event.requestId && waiting.attemptId === event.attemptId);
}

export function makeAnswerCommand(session, requestId, attemptId, payload) {
  const rpiv = session.ask.kind === 'rpiv';
  const fields = payload.cancel ? { cancel: true, ...(payload.globalNote ? { globalNote: payload.globalNote } : {}) } : payload;
  const encoder = new TextEncoder();
  const values = [...(fields.answers || []).flatMap(answer => [answer.customInput, answer.notes]), fields.globalNote];
  if (values.some(value => typeof value === 'string' && encoder.encode(value).length > 16384))
    return { error: 'A custom answer or note exceeds the 16 KiB limit.' };
  const command = JSON.stringify({ type: 'ask_answer', processId: session.processId, sessionId: session.sessionId, requestId, ...(rpiv ? { attemptId } : {}), ...fields });
  if (encoder.encode(command).length > 65536) return { error: 'Answer exceeds the 64 KiB message limit.' };
  return { command };
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (part?.type === 'text' || part?.type === 'thinking') return part.text || part.thinking || '';
    if (part?.type === 'toolCall') return `${part.name || 'Tool'} ${JSON.stringify(part.arguments ?? {})}`;
    if (part?.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

export const initialHistory = { sessions: [], selected: null, entries: [], stream: null, pending: null, awaiting: false, lastEndedAt: null, models: {}, optimistic: {} };
export const DEFAULT_NAME = 'New Session';
export const folderName = cwd => String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || cwd || '';
export const pinFirst = (sessions, pinned) => [...sessions.filter(item => pinned.includes(item.sessionId)), ...sessions.filter(item => !pinned.includes(item.sessionId))];
export const currentSession = state => state.sessions.find(item => item.processId === state.selected);
export const sessionStatus = session => !session.online ? 'offline' : session.waiting ? 'waiting' : session.busy ? 'busy' : 'idle';
export const statusLabel = { idle: 'Idle', busy: 'Busy', offline: 'Offline', waiting: 'Needs input', connecting: 'Connecting…' };
export const buildAsset = html => /src="(\/assets\/index-[^"]+\.js)"/.exec(String(html ?? ''))?.[1] ?? null;

// Mirrors the server's push body.
function noticeBody(event) {
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  if (event?.type === 'agent_settled') return text(event.summary, 200) || 'Finished responding';
  if (event?.type !== 'ui_prompt_start') return null;
  const title = text(event.title, 120);
  return title ? `Needs your input: ${title}` : 'Needs your input';
}

// In-page fallback for a finished prompt or a waiting dialog; callers pass enabled=false while a push subscription covers it.
export function sessionNotice(message, { enabled, hidden, selected, sessions }) {
  const body = message.type === 'event' ? noticeBody(message.event) : null;
  if (!enabled || !body || (!hidden && message.processId === selected)) return null;
  const session = sessions.find(item => item.processId === message.processId);
  return session ? { title: (session.name || DEFAULT_NAME).slice(0, 80), body, tag: session.processId } : null;
}

// iOS only exposes notifications to web apps opened from the Home Screen (iPadOS reports a Mac user agent).
export function needsHomeScreen({ userAgent = '', platform = '', maxTouchPoints = 0, standalone = false, canNotify = false, secure = true }) {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  return ios && secure && !standalone && !canNotify;
}

// Phone drawer gestures: a mostly horizontal swipe right opens the session list, a swipe left closes it.
export function swipeAction({ startX, startY, endX, endY, open, distance = 60 }) {
  const dx = endX - startX;
  if (Math.abs(dx) < distance || Math.abs(endY - startY) * 2 > Math.abs(dx)) return null;
  return !open && dx > 0 ? 'open' : open && dx < 0 ? 'close' : null;
}

// Height of the area above the on-screen keyboard, so the app never extends under it; ignore pinch-zoom.
export const appHeight = ({ height, scale }) => Math.abs(scale - 1) > 0.01 ? null : `${Math.round(height)}px`;

export function selectSession(state, processId) {
  return state.selected === processId ? state : { ...state, selected: processId, entries: [], stream: null, pending: null, awaiting: true, lastEndedAt: null };
}

// A browser pick is shown until the next sessions update that changes that process, then the server value wins.
export function choose(state, processId, choice) {
  return { ...state, optimistic: { ...state.optimistic, [processId]: { ...state.optimistic[processId], ...choice } } };
}
// Drop a pick the agent never confirmed (e.g. setModel refused); a newer pick is kept.
export function unchoose(state, processId, pick) {
  if (state.optimistic[processId] !== pick) return state;
  const { [processId]: _, ...optimistic } = state.optimistic;
  return { ...state, optimistic };
}

const MAX_CHUNKS = 256;
const MAX_CHUNK_UNITS = 128 * 1024;
const MAX_SNAPSHOT_UNITS = MAX_CHUNKS * MAX_CHUNK_UNITS;

// Return a select request when the agent's connection/session changes and a fresh branch is needed.
// Offline processes are selected too: the server replays their last stored snapshot, if any.
export function receive(state, message) {
  if (message.type === 'sessions' && Array.isArray(message.sessions)) {
    const previous = currentSession(state);
    const optimistic = Object.fromEntries(Object.entries(state.optimistic).filter(([processId]) => {
      const find = sessions => JSON.stringify(sessions.find(item => item.processId === processId));
      const next = find(message.sessions);
      return next !== undefined && next === find(state.sessions);
    }));
    let nextState = { ...state, optimistic, sessions: [...message.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) };
    const next = currentSession(nextState);
    const resumed = !next && previous && nextState.sessions.find(item => item.sessionId === previous.sessionId);
    if (resumed) return { state: { ...nextState, selected: resumed.processId, stream: null, pending: null, awaiting: true, lastEndedAt: null }, select: resumed.processId };
    const switched = previous && next && previous.sessionId !== next.sessionId;
    const replaced = previous && next && previous.connectionId !== next.connectionId;
    const disconnected = previous?.online && next && !next.online;
    const reconnected = previous && !previous.online && next?.online;
    if (switched || replaced || disconnected || reconnected) {
      nextState = { ...nextState, entries: switched ? [] : state.entries, stream: null, pending: null, awaiting: true,
        lastEndedAt: switched || replaced ? null : state.lastEndedAt };
    }
    if (!next && message.sessions.length) {
      const processId = nextState.sessions.find(item => item.online)?.processId || nextState.sessions[0].processId;
      nextState = selectSession(nextState, processId);
      return { state: nextState, select: processId };
    }
    if (!next) return { state: { ...nextState, selected: null, entries: [], stream: null, pending: null, awaiting: false, lastEndedAt: null }, select: null };
    return { state: nextState, select: switched || replaced || reconnected ? state.selected : null };
  }
  if (message.type === 'models' && Array.isArray(message.models) &&
      state.sessions.some(item => item.processId === message.processId && item.sessionId === message.sessionId))
    return { state: { ...state, models: { ...state.models, [message.processId]: message.models } } };
  const item = currentSession(state);
  if (!item || message.processId !== state.selected || message.sessionId !== item.sessionId) return { state };
  if (message.type === 'snapshot' && Array.isArray(message.entries)) return { state: finish(state, message.entries) };
  if (message.type === 'snapshot_chunk') {
    const { snapshotId, index, total, data } = message;
    if (typeof snapshotId !== 'string' || !snapshotId || !Number.isSafeInteger(total) || total < 1 || total > MAX_CHUNKS ||
        !Number.isSafeInteger(index) || index < 0 || index >= total || typeof data !== 'string' || data.length > MAX_CHUNK_UNITS)
      return { state: index === 0 && state.pending ? { ...state, pending: null } : state };
    const pending = index === 0 ? { snapshotId, total, parts: [], size: 0 } : state.pending;
    if (!pending || pending.snapshotId !== snapshotId || pending.total !== total || index !== pending.parts.length) return { state };
    const size = pending.size + data.length;
    if (size > MAX_SNAPSHOT_UNITS) return { state: { ...state, pending: null } };
    const parts = [...pending.parts, data];
    if (parts.length !== total) return { state: { ...state, pending: { ...pending, parts, size } } };
    try {
      const entries = JSON.parse(parts.join(''));
      return { state: Array.isArray(entries) ? finish(state, entries) : { ...state, pending: null } };
    } catch { return { state: { ...state, pending: null } }; }
  }
  if (message.type === 'event') {
    const event = message.event;
    if (['message_start', 'message_update', 'message_end'].includes(event?.type) && event.message?.role === 'assistant') {
      const stamp = Number.isFinite(event.message.timestamp) ? event.message.timestamp : null;
      if (stamp !== null && state.lastEndedAt !== null && stamp <= state.lastEndedAt) return { state };
      if (event.type !== 'message_start' && state.stream?.ended) return { state };
      if (event.type !== 'message_start' && stamp !== null && state.stream?.message?.timestamp != null &&
          stamp !== state.stream.message.timestamp) return { state };
      const ended = event.type === 'message_end';
      return { state: { ...state, stream: { message: event.message, ended }, lastEndedAt: ended && stamp !== null ? stamp : state.lastEndedAt } };
    }
  }
  return { state };
}

function finish(state, entries) {
  return { ...state, entries, pending: null, stream: state.stream?.ended ? null : state.stream, awaiting: false };
}

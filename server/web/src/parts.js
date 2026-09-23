export function normalizeParts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    if (part?.type === 'thinking') return typeof part.thinking === 'string' && part.thinking ? [{ type: 'thinking', text: part.thinking }] : [];
    if (part?.type === 'toolCall') return [{ type: 'toolCall', id: part.id, name: typeof part.name === 'string' && part.name ? part.name : 'tool', arguments: part.arguments }];
    if (part?.type === 'image') return [{ type: 'image' }];
    const text = typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '';
    return text ? [{ type: 'text', text }] : [];
  });
}

function fallbackText(message) {
  return normalizeParts(message.content).map(part => part.type === 'image' ? '[image]' : part.text || '').filter(Boolean).join('\n') || [message.summary, message.text, message.output].find(value => typeof value === 'string') || '';
}

// Flatten session entries (+ live stream) into render items; tool results are attached to their calls.
export function buildThread(entries, stream) {
  const messages = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type === 'message' && entry.message && typeof entry.message === 'object') {
      if (entry.message.role !== 'system') messages.push([entry.message, false]);
    }
    else if (entry?.type === 'custom_message' && entry.display)
      messages.push([{ role: 'custom', customType: entry.customType, content: entry.content }, false]);
    else if (entry?.type === 'compaction' || entry?.type === 'branch_summary')
      messages.push([{ role: entry.type === 'compaction' ? 'compactionSummary' : 'branchSummary', summary: entry.summary }, false]);
  }
  if (stream?.message && typeof stream.message === 'object') messages.push([stream.message, !stream.ended]);
  const calls = new Set(messages.flatMap(([message]) => message.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter(part => part?.type === 'toolCall' && part.id).map(part => part.id) : []));
  const results = new Map(messages.filter(([message]) => message.role === 'toolResult' && calls.has(message.toolCallId))
    .map(([message]) => [message.toolCallId, message]));
  return messages.flatMap(([message, streaming]) => {
    const role = typeof message.role === 'string' ? message.role : 'message';
    if (role === 'user') return [{ kind: 'user', parts: normalizeParts(message.content) }];
    if (role === 'assistant') return [{ kind: 'assistant', streaming, error: typeof message.errorMessage === 'string' ? message.errorMessage : '',
      parts: normalizeParts(message.content).map(part => part.type === 'toolCall' ? { ...part, result: part.id ? results.get(part.id) : undefined } : part) }];
    if (role === 'toolResult') return results.has(message.toolCallId) ? [] :
      [{ kind: 'tool', call: { name: typeof message.toolName === 'string' && message.toolName ? message.toolName : 'tool', result: message } }];
    if (role === 'bashExecution') return [{ kind: 'bash', command: String(message.command ?? ''), output: String(message.output ?? ''), exitCode: message.exitCode }];
    if (role === 'compactionSummary' || role === 'branchSummary')
      return [{ kind: 'summary', label: role === 'compactionSummary' ? 'Context compacted' : 'Branch summarized', text: String(message.summary ?? '') }];
    if (role === 'custom') return message.display === false ? [] : [{ kind: 'custom', label: String(message.customType || 'custom'), text: fallbackText(message) }];
    return [{ kind: 'custom', label: role, text: fallbackText(message) }];
  });
}

const firstLine = value => {
  const line = value.trim().split('\n')[0];
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

export function toolSummary(name, args) {
  if (typeof args === 'string') return firstLine(args);
  if (!args || typeof args !== 'object') return '';
  if (/task/i.test(name)) {
    const subject = typeof args.subject === 'string' ? args.subject : args.taskId != null ? `#${args.taskId}` : '';
    const summary = [subject, typeof args.status === 'string' ? args.status : ''].filter(Boolean).join(' · ');
    if (summary) return firstLine(summary);
  }
  const value = ['command', 'path', 'file_path', 'subject', 'query', 'url', 'pattern'].map(key => args[key]).find(item => typeof item === 'string' && item.trim());
  return value ? firstLine(value) : '';
}

export const isBashTool = name => typeof name === 'string' && name.toLowerCase() === 'bash';
export const toolStatus = (result, live) => result?.isError ? 'error' : result ? 'done' : live ? 'pending' : 'incomplete';

export function relativeTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - ms) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}


export const modelKey = model => `${model.provider}\u0000${model.id}`;
export function splitModelKey(key) {
  const index = key.indexOf('\u0000');
  return { provider: key.slice(0, index), modelId: key.slice(index + 1) };
}

// tinyllm registers every model under provider 'tinyllm' with ids like 'openrouter/openai/gpt-5'; the route is what users recognise.
export function modelOption(model) {
  const slash = model.id.indexOf('/');
  const route = slash > 0 ? model.id.slice(0, slash) : model.provider;
  return { value: modelKey(model), id: model.id, provider: model.provider, route, name: model.name || (slash > 0 ? model.id.slice(slash + 1) : model.id),
    label: slash > 0 ? `(${route}) ${model.id.slice(slash + 1)}` : model.id,
    subtitle: route === model.provider ? route : `${route} · via ${model.provider}` };
}

export function groupModels(options) {
  const groups = new Map();
  for (const option of options) {
    if (!groups.has(option.provider)) groups.set(option.provider, []);
    groups.get(option.provider).push(option);
  }
  return [...groups].map(([provider, options]) => ({ provider, options }));
}

export function matchModel(option, query) {
  const needle = query.trim().toLowerCase();
  return !needle || [option.name, option.id, option.route, option.provider].some(value => value.toLowerCase().includes(needle));
}

const levelLabels = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const levelLabel = level => levelLabels[level] ?? level;

// Online sessions with a fetched list get selectable options; otherwise only the last known model name is shown.
export function modelPicker(session, models, choice = {}) {
  if (!session) return null;
  const current = session.model && typeof session.model === 'object' ? session.model : null;
  let list = session.online && Array.isArray(models) ? models : null;
  if (list && current && !list.some(model => modelKey(model) === modelKey(current))) list = [current, ...list];
  const value = choice.model ?? (current ? modelKey(current) : '');
  const chosen = list?.find(model => modelKey(model) === value) ?? current;
  // Levels belong to the server's current model; hide them while an unconfirmed model pick is shown.
  const pending = choice.model && current && choice.model !== modelKey(current);
  const levels = session.online && !pending && Array.isArray(current?.thinkingLevels) ? current.thinkingLevels : [];
  return { value, model: chosen ? modelOption(chosen) : null, options: list && list.map(modelOption),
    level: choice.thinkingLevel ?? session.thinkingLevel ?? '', levels, hasEffort: levels.length > 1 };
}

export function modelTrigger(picker) {
  const effort = picker.hasEffort ? picker.level : '';
  if (!picker.model) return { name: 'Select model', effort, label: 'Select model' };
  const label = `Model: ${picker.model.name} (${picker.model.route})${effort ? `, effort: ${levelLabel(effort).toLowerCase()}` : ''}`;
  return { name: picker.model.name, effort, label };
}

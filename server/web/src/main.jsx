import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildAsset, choose, contentText, unchoose, currentSession, DEFAULT_NAME, folderName, initialHistory, pinFirst, needsHomeScreen, receive, selectSession, sessionNotice, sessionStatus, statusLabel, swipeAction, appHeight } from './history.js';
import { backgroundSummary, buildThread, groupModels, isBashTool, levelLabel, matchModel, modelPicker, modelTrigger, relativeTime, splitModelKey, toolRunning, toolStatus, toolSummary, usageSummary, workingLabel } from './parts.js';
import { Markdown as Text } from './markdown.js';
import ICON_COLORS from './icon-colors.json';
import '@fontsource-variable/geist-mono';
import './style.css';

const canNotify = 'Notification' in window && window.isSecureContext;
const pushCapable = location.protocol === 'https:' && 'serviceWorker' in navigator && 'PushManager' in window;
const homeScreenHint = needsHomeScreen({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints, standalone: navigator.standalone, canNotify, secure: window.isSecureContext });
const IN_PAGE_KEY = 'prc-notifications';
const PIN_KEY = 'prc-pinned';
const SETTINGS_KEY = 'prc-settings';
// Manifest, SVG favicon, PNG favicon, and Apple touch icon; scripts/icons.mjs builds the coloured ones.
const iconFiles = color => color === 'default' ? ['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png']
  : ['.webmanifest', '.svg', '-192.png', '-180.png'].map(suffix => `/icons/${color}${suffix}`);
const SETTING_OPTIONS = {
  theme: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']],
  font: [['system', 'System'], ['ioskeley', 'Ioskeley'], ['geist', 'Geist']],
  size: [['90', '90%'], ['100', '100%'], ['115', '115%'], ['130', '130%']],
  icon: Object.keys(ICON_COLORS).map(color => {
    const label = color[0].toUpperCase() + color.slice(1);
    return [color, <img className="swatch" src={iconFiles(color)[1]} alt={label} title={label} />];
  }),
};
const DEFAULT_SETTINGS = { theme: 'system', font: 'system', size: '100', icon: 'default' };
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { /* Use defaults. */ }
  return Object.fromEntries(Object.entries(SETTING_OPTIONS).map(([key, options]) =>
    [key, options.some(([value]) => value === saved?.[key]) ? saved[key] : DEFAULT_SETTINGS[key]]));
}
function applySettings({ theme, font, size, icon }) {
  const root = document.documentElement;
  Object.assign(root.dataset, { theme, font });
  // Percent keeps the browser's own default text size as the baseline.
  root.style.fontSize = `${size}%`;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
    meta.content = (theme === 'system' ? meta.media.includes('dark') : theme === 'dark') ? '#151515' : '#faf9f5';
  // Home-screen installs copy whatever these point at when added; an existing shortcut keeps its old icon.
  const files = iconFiles(icon);
  ['link[rel="manifest"]', 'link[rel="icon"][type="image/svg+xml"]', 'link[rel="icon"][type="image/png"]', 'link[rel="apple-touch-icon"]']
    .forEach((selector, index) => document.querySelector(selector)?.setAttribute('href', files[index]));
}
applySettings(loadSettings());
// Older builds could save in-page mode on HTTPS, which shows "Disable" while nothing is subscribed.
if (pushCapable) localStorage.removeItem(IN_PAGE_KEY);

const Icon = ({ children, className }) => <svg className={className} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
const Chevron = () => <Icon className="chevron"><path d="m9 18 6-6-6-6" /></Icon>;
const Down = () => <Icon><path d="m6 9 6 6 6-6" /></Icon>;
const Bell = () => <Icon><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></Icon>;
const BellOff = () => <Icon><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742" /><path d="m2 2 20 20" /><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" /></Icon>;
const More = () => <Icon><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></Icon>;
const Pin = () => <Icon><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></Icon>;
const PinOff = () => <Icon><path d="M12 17v5" /><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" /><path d="m2 2 20 20" /><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" /></Icon>;
const Pencil = () => <Icon><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></Icon>;
const Folder = () => <Icon><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Icon>;
const Branch = () => <Icon><path d="M15 6a9 9 0 0 0-9 9V3" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /></Icon>;
const Trash = () => <Icon><path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></Icon>;
const Alert = () => <Icon><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></Icon>;
const Close = () => <Icon><path d="M18 6 6 18M6 6l12 12" /></Icon>;
const Gear = () => <Icon><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></Icon>;
const statusIcons = {
  done: <Icon><path d="M20 6 9 17l-5-5" /></Icon>,
  error: <Icon><path d="M18 6 6 18M6 6l12 12" /></Icon>,
  pending: <Icon className="spinner"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></Icon>,
  incomplete: <Icon><circle cx="12" cy="12" r="9" /></Icon>
};
const statusLabels = { done: 'completed', error: 'failed', pending: 'running', incomplete: 'no result' };

function Terminal({ command, output, exitCode }) {
  return <pre className="terminal">$ <span className="terminal-command">{command}</span>{output ? `\n${output}` : ''}
    {Number.isFinite(exitCode) && exitCode !== 0 && <span className="terminal-exit">{`\nexit ${exitCode}`}</span>}</pre>;
}

function ToolCard({ call, live }) {
  const status = toolStatus(call.result, live);
  const summary = toolSummary(call.name, call.arguments);
  const output = call.result ? contentText(call.result.content) : '';
  return <details className={`tool ${status}`}>
    <summary>{statusIcons[status]}<span className="tool-title"><b>{call.name}</b></span>
      {summary && <span className="tool-summary">{summary}</span>}<span className="sr-only">, {statusLabels[status]}</span><Chevron /></summary>
    <div className="tool-body">{isBashTool(call.name)
      ? <Terminal command={String(call.arguments?.command ?? '')} output={output} />
      : <>
        {call.arguments !== undefined && <pre className="mono">{JSON.stringify(call.arguments, null, 2)}</pre>}
        {call.result && <><div className="tool-label">result</div><pre className="mono">{output || '(no output)'}</pre></>}
      </>}</div>
  </details>;
}

function Parts({ parts }) {
  return parts.map((part, index) => part.type === 'image' ? <span key={index} className="chip">[image]</span> : <span key={index}>{part.text}</span>);
}

// Ticks on its own so only this line re-renders every second, not the conversation.
function Working({ since, running, offset }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <div className="working"><span className="dot busy" aria-hidden="true" />{workingLabel(running, since, now, offset)}</div>;
}

// Tapping an item toggles its full name and command.
function BackgroundJob({ job, now }) {
  const [open, setOpen] = useState(false);
  return <button type="button" className="background-job" aria-expanded={open} onClick={() => setOpen(!open)}>
    <span className="background-kind">{job.kind === 'agent' ? 'agent' : 'shell'}</span>
    <span className="background-label">{job.label}</span>
    <span className="background-time">{relativeTime(job.startedAt, now)}</span>
    {job.detail && <span className="background-detail">{open ? job.full || job.detail : job.detail}</span>}
  </button>;
}

function Item({ item, live }) {
  if (item.kind === 'user') return <div className="msg user"><Parts parts={item.parts} /></div>;
  if (item.kind === 'assistant') return <div className="msg assistant">
    {item.parts.map((part, index) => part.type === 'text' ? <Text key={index} text={part.text} /> :
      part.type === 'thinking' ? <details key={index} className="reasoning" open={item.streaming}>
        <summary><span className={item.streaming ? 'shimmer' : undefined}>thinking</span><Chevron /></summary>
        <div className="reasoning-body"><Text text={part.text} /></div></details> :
      part.type === 'toolCall' ? <ToolCard key={index} call={part} live={live || item.streaming} /> :
      <span key={index} className="chip">[image]</span>)}
    {item.streaming && !item.parts.length && <span className="typing"><span className="sr-only">Pi is responding</span></span>}
    {item.error && <p className="msg-error">{item.error}</p>}
  </div>;
  if (item.kind === 'tool') return <ToolCard call={item.call} live={false} />;
  if (item.kind === 'bash') return <Terminal command={item.command} output={item.output} exitCode={item.exitCode} />;
  if (item.kind === 'summary') return <details className="divider-card"><summary><span>{item.label}</span><Chevron /></summary><div className="card-body"><Text text={item.text} /></div></details>;
  const line = <><span className="card-label">{item.label}</span><span className="tool-summary">{item.summary}</span></>;
  return item.summary === item.text.trim() ? <div className="custom-card"><div className="custom-line">{line}</div></div>
    : <details className="custom-card"><summary>{line}<Chevron /></summary><div className="plain">{item.text}</div></details>;
}

const Back = () => <Icon><path d="m15 18-6-6 6-6" /></Icon>;
const Check = () => <Icon className="menu-check"><path d="M20 6 9 17l-5-5" /></Icon>;

function ModelMenu({ picker, enabled, onOpen, onModel, onThinking }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('main');
  const [query, setQuery] = useState('');
  const trigger = useRef(null);
  const panel = useRef(null);
  const from = useRef(null);
  const id = useId();
  useEffect(() => {
    const node = panel.current;
    if (!open || !node) return;
    const filter = view === 'models' && matchMedia('(pointer: fine)').matches && node.querySelector('input');
    (filter || node.querySelector(view === 'main' ? `[data-view="${from.current}"]` : '[aria-checked="true"]') || node.querySelector('[role^="menuitem"]'))?.focus();
  }, [open, view]);
  const optionKeys = picker?.options?.map(option => option.value).join('\n');
  useEffect(() => {
    // A models refresh can remove the focused row, dropping focus to the body; move it back into the menu.
    const node = panel.current;
    if (open && node && (!document.activeElement || document.activeElement === document.body))
      (node.querySelector('[aria-checked="true"]') || node.querySelector('button, input'))?.focus();
  }, [optionKeys]);
  useEffect(() => {
    if (!open) return;
    const onDown = event => { if (!panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  if (!picker || (!picker.options && !picker.model)) return null;
  const { name, effort, label } = modelTrigger(picker);
  if (!picker.options) return <span className="model-trigger" title={label}><span className="sr-only">Model: </span><span className="model-trigger-text">{name}</span></span>;

  function toggle() {
    if (open) { setOpen(false); return; }
    from.current = null;
    setView('main');
    setQuery('');
    setOpen(true);
    onOpen();
  }
  function close() { setOpen(false); trigger.current?.focus(); }
  function back() { from.current = view; setView('main'); }
  function pick(send, value, current) { close(); if (value !== current) send(value); }
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); view === 'main' ? close() : back(); return; }
    // Enter in the filter would otherwise submit the composer form.
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); return; }
    const keys = event.target.tagName === 'INPUT' ? ['ArrowDown', 'ArrowUp'] : ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const rows = [...panel.current.querySelectorAll('button, input')];
    const index = rows.indexOf(document.activeElement);
    rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
  }
  const backRow = (title, onClick) => <button type="button" className="menu-row menu-back" onClick={onClick}><Back /><span className="sr-only">Back: </span><span className="menu-label">{title}</span></button>;
  const radio = (key, text, checked, onClick, title) => <button key={key} type="button" role="menuitemradio" aria-checked={checked} className="menu-row" title={title} onClick={onClick}>
    <span className="menu-label">{text}</span>{checked && <Check />}</button>;
  const groups = view === 'models' ? groupModels(picker.options.filter(option => matchModel(option, query))) : [];

  return <>
    <button ref={trigger} type="button" className="model-trigger" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} disabled={!enabled} onClick={toggle} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); } }}>
      <span className="model-trigger-text" aria-hidden="true">{name}{effort && <span className="model-effort"> · {effort}</span>}</span><Down /></button>
    {open && <div ref={panel} id={id} className="model-menu" role="dialog" aria-label="Model settings" onKeyDown={onKey}
      onBlur={event => { if (event.relatedTarget && event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      {view === 'main' ? <>
        <div className="menu-header"><div className="menu-title">{picker.model?.name || 'No model selected'}</div>
          {picker.model && <div className="menu-subtitle">{picker.model.subtitle}</div>}</div>
        <div role="menu" aria-label="Model settings">
          {picker.hasEffort && <button type="button" role="menuitem" aria-haspopup="menu" data-view="effort" className="menu-row" onClick={() => setView('effort')}>
            <span className="menu-label">Effort</span><span className="menu-hint">{levelLabel(picker.level)}</span><Chevron /></button>}
          <button type="button" role="menuitem" aria-haspopup="menu" data-view="models" className="menu-row" onClick={() => setView('models')}>
            <span className="menu-label">Change model</span><Chevron /></button>
        </div>
      </> : view === 'effort' ? <>
        {backRow('Effort', back)}
        <div role="menu" aria-label="Effort">{picker.levels.map(level => radio(level, levelLabel(level), level === picker.level, () => pick(onThinking, level, picker.level)))}</div>
      </> : <>
        {backRow('Models', back)}
        {/* A refresh can shrink the list mid-filter; keep the box so the query stays clearable. */}
        {(picker.options.length > 8 || query) && <input className="model-filter" type="search" aria-label="Filter models" placeholder="Search models" value={query} onChange={event => setQuery(event.target.value)} />}
        {groups.length ? <div role="menu" aria-label="Models">{groups.map(group => <div key={group.provider} role="group" aria-label={group.provider}>
          <div className="menu-heading" aria-hidden="true">{group.provider}</div>
          {group.options.map(option => radio(option.value, option.label, option.value === picker.value, () => pick(onModel, option.value, picker.value), option.name))}
        </div>)}</div> : <p className="menu-empty">No models match</p>}
      </>}
    </div>}
  </>;
}

function Location({ session }) {
  return <span className="location" title={session.cwd}><span className="location-text">{folderName(session.cwd)}</span>
    {session.branch && <><span aria-hidden="true">·</span><span className="location-text">{session.branch}</span></>}</span>;
}

function SessionMenu({ actions, label, className = '', buttonRef, align = 'end' }) {
  const id = useId();
  const panel = useRef(null);
  // Top-layer popover escapes the scrolling sidebar; align it to the trigger, kept on screen and flipped up near the bottom.
  function place(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const { clientWidth, clientHeight } = document.documentElement;
    const width = parseFloat(getComputedStyle(panel.current).width);
    const up = rect.bottom > clientHeight * 0.6;
    Object.assign(panel.current.style, { left: `${align === 'start' ? Math.min(rect.left, clientWidth - width - 8) : Math.max(8, rect.right - width)}px`,
      top: up ? 'auto' : `${rect.bottom + 4}px`, bottom: up ? `${clientHeight - rect.top + 4}px` : 'auto' });
  }
  return <>
    <button ref={buttonRef} type="button" className={`icon-button actions-trigger ${className}`} popoverTarget={id} aria-label={label} title="Session actions" onClick={place}><More /></button>
    <div ref={panel} id={id} popover="auto" className="session-menu">
      {actions.map(action => <button key={action.label} type="button" className={`menu-row${action.danger ? ' danger' : ''}`}
        onClick={() => { panel.current.hidePopover(); action.run(); }}>{action.icon}<span className="menu-label">{action.label}</span></button>)}
    </div>
  </>;
}

function Choice({ legend, name, value, onChange }) {
  return <fieldset className="choice"><legend>{legend}</legend><div className="segmented">
    {SETTING_OPTIONS[name].map(([key, label]) => <label key={key}>
      <input type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(name, key)} /><span>{label}</span></label>)}
  </div></fieldset>;
}

function SettingsDialog({ dialog, settings, onChange, onSignOut }) {
  return <dialog ref={dialog} className="settings" aria-labelledby="settings-title"
    onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="settings-body">
      <div className="settings-header"><h2 id="settings-title">Settings</h2>
        <button type="button" className="icon-button" aria-label="Close settings" onClick={() => dialog.current.close()}><Close /></button></div>
      <Choice legend="Theme" name="theme" value={settings.theme} onChange={onChange} />
      <Choice legend="Font" name="font" value={settings.font} onChange={onChange} />
      <Choice legend="Text size" name="size" value={settings.size} onChange={onChange} />
      <Choice legend="App icon" name="icon" value={settings.icon} onChange={onChange} />
      <p className="settings-hint">Used by the browser tab and new home-screen shortcuts. To change an existing shortcut, remove it and add it again.</p>
      <div className="settings-actions"><span className="settings-label">Account</span>
        <button type="button" className="settings-button" onClick={onSignOut}>Sign out</button></div>
    </div>
  </dialog>;
}

function App() {
  // Sign-in form messages only; the control view reports through toasts.
  const [status, setStatus] = useState('Connecting…');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const clockOffset = useRef(0);
  const [signedIn, setSignedIn] = useState(false);
  const [history, setHistory] = useState(initialHistory);
  const [drafts, setDrafts] = useState({});
  const text = drafts[history.selected] ?? '';
  function setText(value) { const id = data.current.selected; setDrafts(all => ({ ...all, [id]: value })); }
  const [pushKey, setPushKey] = useState(null);
  const [subscribed, setSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [inPage, setInPage] = useState(() => canNotify && localStorage.getItem(IN_PAGE_KEY) === '1');
  const notifyOn = subscribed || inPage;
  const removing = useRef(null);
  const notifying = useRef(null);
  notifying.current = { inPage, subscribed };
  const wanted = useRef(new URLSearchParams(location.search).get('session'));
  const [drawer, setDrawer] = useState(false);
  const drawerOpen = useRef(false);
  drawerOpen.current = drawer;
  const [atBottom, setAtBottom] = useState(true);
  const [editing, setEditing] = useState(null);
  const [pinned, setPinned] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem(PIN_KEY)); return Array.isArray(saved) ? saved : []; } catch { return []; }
  });
  const shownCount = useRef(0);
  const [now, setNow] = useState(Date.now());
  const data = useRef(initialHistory);
  const socket = useRef(null);
  const retry = useRef(null);
  const connectRef = useRef(null);
  const log = useRef(null);
  const input = useRef(null);
  const menu = useRef(null);
  const sidebar = useRef(null);
  const actionsButton = useRef(null);
  const renameDone = useRef(false);
  const settingsDialog = useRef(null);
  const [settings, setSettings] = useState(loadSettings);

  function publish(next) { data.current = next; setHistory(next); }
  function notify(text, tone = 'success') {
    clearTimeout(toastTimer.current);
    setToast({ text, tone, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), tone === 'error' ? 6000 : 2500);
  }
  function usable() { return socket.current?.readyState === WebSocket.OPEN && currentSession(data.current)?.online; }
  function sendSelect(processId) {
    const session = data.current.sessions.find(item => item.processId === processId);
    if (socket.current?.readyState !== WebSocket.OPEN || !session) return;
    socket.current.send(JSON.stringify({ type: 'select', processId }));
    if (session.online) socket.current.send(JSON.stringify({ type: 'models', processId }));
  }
  function refreshModels() {
    if (usable()) socket.current.send(JSON.stringify({ type: 'models', processId: currentSession(data.current).processId }));
  }
  function openSession(processId) {
    if (!data.current.sessions.some(item => item.processId === processId)) return false;
    publish(selectSession(data.current, processId));
    sendSelect(processId);
    setDrawer(false);
    return true;
  }
  function select(processId) {
    publish(selectSession(data.current, processId));
    sendSelect(processId);
    if (drawer) closeDrawer();
    // Touch keyboards would cover the conversation that was just opened.
    if (matchMedia('(pointer: fine)').matches) requestAnimationFrame(() => input.current?.focus());
  }
  function openDrawer() { setDrawer(true); requestAnimationFrame(() => sidebar.current?.querySelector('button')?.focus()); }
  function closeDrawer() { setDrawer(false); menu.current?.focus(); }
  function scrollToBottom() {
    const node = log.current;
    node?.scrollTo({ top: node.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  const item = currentSession(history);
  const socketOpen = socket.current?.readyState === WebSocket.OPEN;
  const active = socketOpen && item?.online;
  const busy = Boolean(active && item.busy);
  const items = buildThread(history.entries, history.stream);
  const usage = item && usageSummary(history.entries, item.context);
  const title = history.optimistic[item?.processId]?.name ?? item?.name;
  const badge = !socketOpen ? 'connecting' : item ? sessionStatus(item) : null;
  const renameKey = active ? `${item.processId}\u0000${item.sessionId}` : null;
  const renaming = editing !== null && editing === renameKey;
  const notice = !item ? history.sessions.length ? 'Select a session to view its conversation.' : 'No sessions yet. In Pi, run /rc to connect a session.' :
    !socketOpen ? 'Connection lost. Reconnecting to the server…' : !item.online ? 'Offline — showing last saved conversation' : null;

  useEffect(() => {
    const node = log.current;
    if (!node) return;
    const loaded = !shownCount.current && history.entries.length;
    if (loaded || node.scrollHeight - node.scrollTop - node.clientHeight < 80) node.scrollTop = node.scrollHeight;
    shownCount.current = history.entries.length;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 80);
  }, [history]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 192)}px`;
  }, [text, signedIn]);
  useEffect(() => setEditing(key => key === renameKey ? key : null), [renameKey]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  // The focused menu unmounts with its row; keep keyboard and screen-reader users in the list.
  useEffect(() => {
    const pending = removing.current;
    if (!pending || history.sessions.some(item => item.processId === pending.processId)) return;
    removing.current = null;
    const next = pending.next && sidebar.current?.querySelector(`[data-process="${CSS.escape(pending.next)}"]`);
    (next || sidebar.current?.querySelector('#sessions button') || menu.current)?.focus();
  }, [history.sessions]);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const height = appHeight(vv);
      if (height) document.documentElement.style.setProperty('--app-height', height);
      // iOS scrolls the page to reveal a focused field and can leave it scrolled, stranding the composer mid-screen.
      if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  useEffect(() => {
    const phone = matchMedia('(max-width: 759px)');
    let start = null;
    // Leave horizontal gestures to scrollable content, text fields, and the model menu.
    const onStart = event => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && phone.matches && sidebar.current && !event.target.closest?.('pre, .table-wrap, input, textarea, select, dialog, [role="dialog"]')
        ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onEnd = event => {
      if (!start) return;
      const touch = event.changedTouches[0];
      const action = swipeAction({ startX: start.x, startY: start.y, endX: touch.clientX, endY: touch.clientY, open: drawerOpen.current });
      start = null;
      if (action === 'open') openDrawer();
      else if (action === 'close') closeDrawer();
    };
    const onCancel = () => { start = null; };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
    };
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const onKey = event => { if (event.key === 'Escape') closeDrawer(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  useEffect(() => {
    let mounted = true;
    async function checkPush() {
      if (location.protocol !== 'https:' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
      try {
        const response = await fetch('/api/push-key', { cache: 'no-store' });
        if (!response.ok || !mounted) return;
        const key = (await response.json()).publicKey;
        if (!key) return;
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          const saved = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: existing }) });
          if (!saved.ok) throw new Error('Subscribe failed');
        }
        if (mounted) { setPushKey(key); setSubscribed(Boolean(existing)); }
      } catch { /* Push is optional. */ }
    }
    function connect() {
      if (!mounted || socket.current) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ui`);
      socket.current = ws;
      ws.onopen = () => {
        if (!mounted) return;
        setSignedIn(true);
        setHistory({ ...data.current });
        if (data.current.selected) sendSelect(data.current.selected);
        checkPush();
        // A restarted server may ship a new UI build; without this the open tab keeps running old code.
        const loaded = buildAsset(document.documentElement.outerHTML);
        fetch('/', { cache: 'no-store' }).then(response => response.ok ? response.text() : '').then(html => {
          const served = buildAsset(html);
          if (mounted && loaded && served && served !== loaded) location.reload();
        }).catch(() => {});
      };
      ws.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'error') { notify(message.message || 'Command failed', 'error'); publish({ ...data.current, optimistic: {} }); return; }
          const note = sessionNotice(message, { enabled: notifying.current.inPage && !notifying.current.subscribed && Notification.permission === 'granted',
            hidden: document.hidden, selected: data.current.selected, sessions: data.current.sessions });
          if (message.type === 'sessions' && Number.isFinite(message.now)) clockOffset.current = message.now - Date.now();
          const result = receive(data.current, message);
          publish(result.state);
          if (wanted.current && openSession(wanted.current)) {
            wanted.current = null;
            window.history.replaceState(null, '', location.pathname);
          } else if (result.select) sendSelect(result.select);
          if (note) showNotice(note);
        } catch { notify('Invalid server message', 'error'); }
      };
      ws.onclose = async () => {
        if (!mounted || socket.current !== ws) return;
        socket.current = null;
        publish({ ...data.current, stream: null, pending: null, awaiting: true });
        try {
          const response = await fetch('/api/push-key', { cache: 'no-store' });
          if (!mounted || socket.current) return;
          if (response.status === 401) { setSignedIn(false); setStatus('Sign in required'); return; }
        } catch { /* Network failure: retry. */ }
        if (mounted && !socket.current) retry.current = setTimeout(connect, 1500);
      };
    }
    function showNotice({ title, body, tag }) {
      try {
        const shown = new Notification(title, { body, tag, icon: '/icon-192.png' });
        shown.onclick = () => { window.focus(); openSession(tag); shown.close(); };
      } catch { /* Some mobile browsers only allow service-worker notifications. */ }
    }
    function onWorkerMessage(event) {
      if (event.data?.type !== 'open-session' || typeof event.data.processId !== 'string') return;
      wanted.current = openSession(event.data.processId) ? null : event.data.processId;
    }
    connectRef.current = connect;
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    fetch('/api/push-key', { cache: 'no-store' }).then(response => {
      if (!mounted) return;
      if (response.status === 401) { setSignedIn(false); setStatus('Sign in required'); }
      else { setSignedIn(true); connect(); }
    }).catch(() => { if (mounted) { setSignedIn(true); connect(); } });
    return () => { mounted = false; clearTimeout(retry.current); socket.current?.close(); socket.current = null; navigator.serviceWorker?.removeEventListener('message', onWorkerMessage); };
  }, []);

  async function signIn(event) {
    event.preventDefault();
    setStatus('Signing in…');
    const password = event.currentTarget.elements.password;
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
      if (!response.ok) { setStatus(response.status === 401 ? 'Invalid password' : response.status === 403 ? 'This address is not enabled; open the configured server URL' : 'Sign-in failed'); return; }
      password.value = '';
      setSignedIn(true);
      clearTimeout(retry.current);
      connectRef.current();
    } catch { setStatus('Cannot reach server'); }
  }
  function prompt(event) {
    event.preventDefault();
    if (!usable() || !text.trim()) return;
    if (new TextEncoder().encode(text).length > 16 * 1024) { notify('Message exceeds 16 KB', 'error'); return; }
    const current = currentSession(data.current);
    socket.current.send(JSON.stringify({ type: 'prompt', processId: current.processId, sessionId: current.sessionId, text }));
    setText('');
  }
  function onPromptKey(event) {
    // Touch keyboards have no Shift+Enter, so Enter stays a newline on coarse pointers.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !matchMedia('(pointer: fine)').matches) return;
    event.preventDefault();
    event.currentTarget.form.requestSubmit();
  }
  function abort() {
    if (!usable() || !currentSession(data.current).busy) return;
    const current = currentSession(data.current);
    socket.current.send(JSON.stringify({ type: 'abort', processId: current.processId, sessionId: current.sessionId }));
  }
  function sendChoice(message, choice) {
    if (!usable()) return;
    const current = currentSession(data.current);
    socket.current.send(JSON.stringify({ ...message, processId: current.processId, sessionId: current.sessionId }));
    publish(choose(data.current, current.processId, choice));
    const pick = data.current.optimistic[current.processId];
    setTimeout(() => publish(unchoose(data.current, current.processId, pick)), 5000);
  }
  function startRename(session) {
    if (session.processId !== data.current.selected) openSession(session.processId);
    renameDone.current = false;
    setEditing(`${session.processId}\u0000${session.sessionId}`);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); notify(`${what} copied`); }
    catch { notify(`Could not copy ${what.toLowerCase()}`, 'error'); }
  }
  function togglePin(sessionId) {
    const next = pinned.includes(sessionId) ? pinned.filter(id => id !== sessionId) : [...pinned, sessionId];
    localStorage.setItem(PIN_KEY, JSON.stringify(next));
    setPinned(next);
  }
  const displayName = session => (history.optimistic[session.processId]?.name ?? session.name) || DEFAULT_NAME;
  const sessionActions = session => [
    socketOpen && session.online && { label: 'Rename', icon: <Pencil />, run: () => startRename(session) },
    session.cwd && { label: 'Copy full path', icon: <Folder />, run: () => copy(session.cwd, 'Path') },
    session.branch && { label: 'Copy current branch', icon: <Branch />, run: () => copy(session.branch, 'Branch') },
    pinned.includes(session.sessionId) ? { label: 'Unpin', icon: <PinOff />, run: () => togglePin(session.sessionId) }
      : { label: 'Pin', icon: <Pin />, run: () => togglePin(session.sessionId) },
    socketOpen && !session.online && { label: 'Remove', icon: <Trash />, danger: true, run: () => removeSession(session) },
  ].filter(Boolean);
  function finishRename(value) {
    const current = currentSession(data.current);
    // Unmounting on a session switch can blur the input after the selection moved; never rename the new session.
    if (renameDone.current || !current || editing !== `${current.processId}\u0000${current.sessionId}`) return;
    renameDone.current = true;
    setEditing(null);
    const name = value.trim();
    if (name !== title) sendChoice({ type: 'rename', name }, name ? { name } : {});
  }
  function onRenameKey(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    else if (event.key === 'Escape') {
      renameDone.current = true;
      setEditing(null);
      requestAnimationFrame(() => actionsButton.current?.focus());
    }
  }
  const changeModel = value => sendChoice({ type: 'set_model', ...splitModelKey(value) }, { model: value });
  const changeThinking = level => sendChoice({ type: 'set_thinking', level }, { thinkingLevel: level });
  function removeSession(session) {
    const name = displayName(session);
    if (!confirm(`Remove "${name}" from the list? Its saved conversation copy on this server is deleted. Pi's own session is not affected.`)) return;
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    const list = pinFirst(data.current.sessions, pinned);
    const index = list.findIndex(item => item.processId === session.processId);
    removing.current = { processId: session.processId, next: (list[index + 1] ?? list[index - 1])?.processId };
    socket.current.send(JSON.stringify({ type: 'remove', processId: session.processId }));
  }

  async function toggleNotifications() {
    setPushBusy(true);
    try {
      if (subscribed || inPage) {
        localStorage.removeItem(IN_PAGE_KEY);
        setInPage(false);
        const existing = subscribed && await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (existing) {
          const response = await fetch('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: existing.endpoint }) });
          if (!response.ok) throw new Error('Unsubscribe failed');
          await existing.unsubscribe();
        }
        setSubscribed(false);
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked in browser settings' : 'Notification permission denied');
        // A tap before checkPush finishes must still choose push on HTTPS; in-page mode cannot notify from an iOS Home Screen app.
        const key = pushKey || (pushCapable && (await (await fetch('/api/push-key', { cache: 'no-store' })).json()).publicKey);
        if (key) {
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          const response = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) });
          if (!response.ok) { await subscription.unsubscribe(); throw new Error('Subscribe failed'); }
          setPushKey(key);
          setSubscribed(true);
        } else if (pushCapable) {
          throw new Error('Push notifications are unavailable on this server');
        } else {
          localStorage.setItem(IN_PAGE_KEY, '1');
          setInPage(true);
        }
      }
    } catch (error) { notify(error.message || 'Notifications unavailable', 'error'); }
    finally { setPushBusy(false); }
  }
  function changeSetting(key, value) {
    const next = { ...settings, [key]: value };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    applySettings(next);
    setSettings(next);
  }
  async function signOut() {
    try {
      const response = await fetch('/api/logout', { method: 'POST' });
      if (!response.ok && response.status !== 401) throw new Error();
    } catch { notify('Sign-out failed', 'error'); return; }
    settingsDialog.current?.close();
    const ws = socket.current;
    socket.current = null;
    clearTimeout(retry.current);
    ws?.close();
    publish(initialHistory);
    setDrafts({});
    setDrawer(false);
    setSignedIn(false);
    setStatus('Signed out');
  }

  const brand = <div className="brand"><span className="logo" aria-hidden="true">π</span><span className="slash" aria-hidden="true">/</span><h1><span className="sr-only">Pi </span>remote control</h1></div>;
  if (!signedIn) return <main id="login"><form id="login-form" onSubmit={signIn}>
    {brand}<p>Sign in to your private Pi sessions.</p><label htmlFor="password">password</label>
    <input id="password" name="password" type="password" autoComplete="current-password" required />
    <button>sign in</button><p id="status" role="status">{status}</p>
  </form></main>;

  const empty = !item ? <div className="empty"><h2>Nothing to show yet</h2><p>{notice}</p></div> :
    !socketOpen ? <div className="empty"><h2>Reconnecting…</h2><p>{notice}</p></div> :
    !item.online ? <div className="empty"><h2>Session offline</h2><p>Its last saved conversation appears here when available.</p></div> :
    history.awaiting ? <div className="skeleton" aria-busy="true"><span className="sr-only">Loading conversation…</span><i /><i /><i /></div> :
    <div className="empty"><h2>How can I help you today?</h2><p>Send a message to Pi to begin.</p></div>;

  return <div id="control">
    <aside id="sidebar" ref={sidebar} className={drawer ? 'open' : undefined} aria-label="Sessions">
      <div className="sidebar-header">{brand}</div>
      <nav id="sessions">
        {pinFirst(history.sessions, pinned).map(session => {
          const state = sessionStatus(session);
          const name = displayName(session);
          const isPinned = pinned.includes(session.sessionId);
          return <div key={session.processId} className={`thread-row ${state}`}>
            <button type="button" className="thread-item" data-process={session.processId} title={session.cwd} aria-current={session.processId === history.selected ? 'true' : undefined} onClick={() => select(session.processId)}>
              <span className={`dot ${state}`} aria-hidden="true" /><span className="thread-item-title">{name}</span>
              <span className="thread-item-time">{isPinned && <Pin />}{relativeTime(session.updatedAt, now)}</span>
              <Location session={session} />
              <span className="sr-only">, {statusLabel[state]}{isPinned ? ', pinned' : ''}</span>
            </button>
            <SessionMenu actions={sessionActions(session)} label={`Actions for ${name}`} className="thread-actions" />
          </div>;
        })}
        {!history.sessions.length && <p className="sidebar-empty">Connected Pi sessions appear here.</p>}
      </nav>
      <div className="sidebar-footer">
        {homeScreenHint && <p className="sidebar-hint">For notifications on iPhone or iPad: tap Share, then Add to Home Screen, and open Pi Remote Control from the Home Screen.</p>}
        <button type="button" className="menu-row" aria-haspopup="dialog" onClick={() => settingsDialog.current.showModal()}><Gear /><span className="menu-label">Settings</span></button>
      </div>
    </aside>
    <SettingsDialog dialog={settingsDialog} settings={settings} onChange={changeSetting} onSignOut={signOut} />
    {drawer && <div className="backdrop" onClick={closeDrawer} />}
    <main className="conversation" aria-label="Conversation">
      <header className="thread-header">
        <button ref={menu} type="button" className="icon-button menu-button" aria-label="Sessions" aria-controls="sidebar" aria-expanded={drawer} onClick={() => drawer ? closeDrawer() : openDrawer()}>
          <Icon><path d="M4 6h16M4 12h16M4 18h16" /></Icon></button>
        <div className="thread-heading"><div className="thread-title">{renaming
          ? <input className="title-input" aria-label="Session name" defaultValue={title} maxLength={1024} autoFocus
            onFocus={event => event.currentTarget.select()} onBlur={event => finishRename(event.currentTarget.value)} onKeyDown={onRenameKey} />
          : <><h2 id="session-title">{item ? displayName(item) : 'Your chats'}</h2>
            {item && <SessionMenu actions={sessionActions(item)} label={`Actions for ${displayName(item)}`} buttonRef={actionsButton} align="start" />}</>}</div>
          {item && <Location session={item} />}</div>
        {badge && <span className={`badge ${badge}`}><span className={`dot ${badge}`} aria-hidden="true" />{statusLabel[badge]}</span>}
        {canNotify && <button type="button" className={`icon-button notify-toggle${notifyOn ? ' on' : ''}`} aria-pressed={notifyOn} disabled={pushBusy}
          aria-label="Notifications" title={notifyOn ? 'Notifications on' : 'Notifications off'} onClick={toggleNotifications}>{notifyOn ? <Bell /> : <BellOff />}</button>}
        <div className="toast-region" role="status" aria-live="polite">{toast && <div key={toast.id} className={`toast ${toast.tone}`}>
          {toast.tone === 'error' ? <Alert /> : <Check />}<span>{toast.text}</span></div>}</div>
      </header>
      <div id="history" ref={log} role="log" aria-live="polite" aria-relevant="additions" onScroll={event => {
        const node = event.currentTarget;
        setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 80);
      }}>
        <div className="thread">
          {notice && item && items.length > 0 && <p className="notice">{notice}</p>}
          {items.length ? items.map((entry, index) => <Item key={index} item={entry} live={busy && index === items.length - 1} />) : empty}
        </div>
      </div>
      <div className="composer-wrap">
        {!atBottom && <button type="button" className="icon-button scroll-bottom" aria-label="Scroll to bottom" onClick={scrollToBottom}><Icon><path d="M12 5v14M19 12l-7 7-7-7" /></Icon></button>}
        {busy && <Working since={item.busySince} running={toolRunning(items)} offset={clockOffset.current} />}
        {active && item.background?.length > 0 && <details className="background">
          <summary><span className="dot busy" aria-hidden="true" /><span className="background-summary">{backgroundSummary(item.background)}</span><Chevron /></summary>
          <ul>{item.background.map(job => <li key={`${job.kind}:${job.id}`}><BackgroundJob job={job} now={now} /></li>)}</ul>
        </details>}
        {active && item.queued?.length > 0 && <div className="queue">
          <div className="queue-label">{item.queued.length > 1 ? 'queued · sent as one message' : 'queued'}</div>
          <ol aria-label="Queued follow-ups">{item.queued.map((queued, index) => <li key={index} title={queued}>{queued}</li>)}</ol>
        </div>}
        <form id="composer" onSubmit={prompt}><label htmlFor="prompt" className="sr-only">Message</label>
          <textarea id="prompt" ref={input} rows="1" value={text} onChange={event => setText(event.target.value)} onKeyDown={onPromptKey} disabled={!active}
            placeholder={!item ? 'Select a session' : !socketOpen ? 'Reconnecting…' : !item.online ? 'Offline — showing last saved conversation' : busy ? 'Queue a follow-up ...' : 'Write a message ...'} />
          <div className="composer-actions">
            {/* Remounting on session switch, offline, or socket drop closes the menu. */}
            <ModelMenu key={renameKey} picker={modelPicker(item, history.models[item?.processId], history.optimistic[item?.processId])} enabled={active} onOpen={refreshModels} onModel={changeModel} onThinking={changeThinking} />
            {usage && <span className="usage" title={usage.title}><span className="sr-only">Context and cost: </span>{usage.text}</span>}
            {busy && !text.trim()
              ? <button key="abort" id="abort" type="button" className="cmd" aria-label="Stop" onClick={abort}><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" /></svg></button>
              : <button key="send" id="send" type="submit" className="cmd" aria-label={busy ? 'Send follow-up' : 'Send message'} disabled={!active || !text.trim()}><Icon><path d="M12 19V5M5 12l7-7 7 7" /></Icon></button>}
          </div>
        </form>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

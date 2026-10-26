const { JSDOM } = require('jsdom');
const env = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/preview.html?scenario=conversation', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'HTMLTextAreaElement']) Object.defineProperty(globalThis, key, { value: env.window[key], configurable: true });
globalThis.getComputedStyle = env.window.getComputedStyle.bind(env.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { Simulate } = require('react-dom/test-utils');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ReactionBar } = require('../client/src/ui/components/ReactionBar.tsx');
const { SearchPanel } = require('../client/src/ui/components/SearchPanel.tsx');
const { PreferencesPanel } = require('../client/src/ui/components/PreferencesPanel.tsx');
const { QuotePreview } = require('../client/src/ui/components/QuotePreview.tsx');
const { ConnectionBanner } = require('../client/src/ui/components/ConnectionBanner.tsx');
const { MessageList } = require('../client/src/ui/components/MessageList.tsx');
const { ChatComposer } = require('../client/src/ui/components/ChatComposer.tsx');
const { CodeBlock } = require('../client/src/ui/components/CodeBlock.tsx');
const { MessageRow } = require('../client/src/ui/components/MessageRow.tsx');
const { formatDateTime, formatMessageTime } = require('../client/src/ui/format.ts');
const { PinnedMessagePanel } = require('../client/src/ui/components/PinnedMessagePanel.tsx');
const { BookmarksPanel } = require('../client/src/ui/components/BookmarksPanel.tsx');
const { MemberActivity } = require('../client/src/ui/components/MemberActivity.tsx');
const { ChatScreen } = require('../client/src/ui/ChatScreen.tsx');
const { JoinScreen } = require('../client/src/ui/JoinScreen.tsx');
const { PreviewHost } = require('../client/src/preview/PreviewHost.tsx');
const { PREVIEW_SCENARIOS } = require('../client/src/preview/EnglishMockScenarios.ts');
const { makeMockBindings } = require('../client/src/preview/MockCallbacks.ts');
const { projectPreviewComposer } = require('../client/src/preview/previewModel.ts');
const h = React.createElement;
let root;
const render = node => act(() => root.render(node));
const click = node => { assert.ok(node, 'control exists'); act(() => node.click()); };
const named = name => Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || b.textContent).trim() === name);
const key = (node, value, options = {}) => {
 const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
 act(() => node.dispatchEvent(event));
 return !event.defaultPrevented;
};
const scenario = id => PREVIEW_SCENARIOS.find(s => s.id === id).view.chat;
const bindings = () => makeMockBindings({ log: () => {}, getComposerFacts: () => ({ shortcut: 'enter', mode: 'text', canSubmit: true }), onMockShortcutSubmit: () => {} });
beforeEach(() => { document.body.innerHTML = '<button id="outside">Outside</button><div id="root"></div>'; root = createRoot(document.getElementById('root')); window.history.replaceState(null, '', '/preview.html?scenario=conversation'); });
afterEach(() => { act(() => root.unmount()); assert.equal(document.querySelectorAll('[inert]').length, 0, 'modal cleanup restores background'); });
after(() => env.window.close());

const reactions = [ { emoji: '👍', count: 0, reactedByMe: false, pending: true, enabled: true }, { emoji: '❤️', count: 0, reactedByMe: false, pending: false, enabled: false }, { emoji: '✅', count: 2, reactedByMe: true, pending: false, enabled: true } ];
test('pending/disabled reactions cannot be activated through either entrance', () => {
 const calls = []; render(h(ReactionBar, { reactions, enabled: true, onSet: (...x) => calls.push(x) }));
 assert.ok(document.querySelector('[aria-busy="true"]')); click(named('Add reaction'));
 for (const label of ['React with thumbs up', 'React with heart']) { assert.equal(named(label).disabled, true); click(named(label)); }
 assert.equal(calls.length, 0); click(named('React with check mark')); assert.deepEqual(calls, [['✅', false]]);
});
test('an open picker closes immediately on global disable and stays closed after re-enable', () => {
 const props = { reactions, onSet: () => assert.fail('disabled callback') };
 render(h(ReactionBar, { ...props, enabled: true })); click(named('Add reaction'));
 render(h(ReactionBar, { ...props, enabled: false })); assert.equal(document.querySelector('[role="menu"]'), null);
 render(h(ReactionBar, { ...props, enabled: true })); assert.equal(document.querySelector('[role="menu"]'), null);
});
test('reaction keyboard navigation skips disabled items and Escape restores its trigger', () => {
 render(h(ReactionBar, { reactions, enabled: true, onSet: () => {} })); const trigger = named('Add reaction'); trigger.focus(); click(trigger);
 assert.equal(document.activeElement, named('React with joy')); key(document.activeElement, 'End'); assert.equal(document.activeElement, named('React with check mark'));
 key(document.activeElement, 'Escape'); assert.equal(document.querySelector('[role="menu"]'), null); assert.equal(document.activeElement, trigger);
});
test('expired quote preserves summary and exposes no navigation button', () => {
 const view = scenario('reply-composer-expired').composer.replyPreview;
 render(h(QuotePreview, { view, onNavigate: () => assert.fail('expired navigation') }));
 assert.ok(document.getElementById('root').textContent.includes(view.previewText)); assert.equal(document.querySelector('#root button'), null);
});
test('search focuses each opening, preserves focus on updates and restores on close', () => {
 let closes = 0; const props = { history: scenario('conversation').history, onQueryChange: () => {}, onSelectResult: () => {}, onRetry: () => {}, onClose: () => closes++ };
 const trigger = document.getElementById('outside'); trigger.focus();
 render(h(SearchPanel, { ...props, view: { phase: 'closed', query: '' } })); key(document, 'Escape'); assert.equal(closes, 0);
 render(h(SearchPanel, { ...props, view: { phase: 'idle', query: '' } })); assert.equal(document.activeElement, document.querySelector('input'));
 const closeButton = named('Close search'); closeButton.focus();
 render(h(SearchPanel, { ...props, onClose: () => closes++, view: { phase: 'loading', query: 'ACK' } })); assert.equal(document.activeElement, closeButton);
 key(document, 'Escape'); assert.equal(closes, 1);
 render(h(SearchPanel, { ...props, view: { phase: 'closed', query: 'ACK' } })); assert.equal(document.activeElement, trigger);
 render(h(SearchPanel, { ...props, view: { phase: 'idle', query: 'ACK' } })); assert.equal(document.activeElement, document.querySelector('input'));
});
function PrefHost() {
 const [prefs, setPrefs] = React.useState(scenario('conversation').preferences);
 return h(PreferencesPanel, { preferences: prefs, sound: { mode: prefs.soundMode, playback: 'ready' }, onClose: () => {}, callbacks: { ...bindings().callbacks, onSoundModeChange: mode => setPrefs({ ...prefs, soundMode: mode }), onPreviewSound: () => {}, onShortcutChange: () => {}, onShareTypingChange: enabled => setPrefs({ ...prefs, shareTyping: enabled }) } });
}
test('preferences updates preserve focus, trap Tab, and keep background inert', () => {
 document.getElementById('outside').focus(); render(h(PrefHost));
 const on = named('On'); on.focus(); click(on); assert.equal(document.activeElement, on); assert.ok(document.getElementById('root').hasAttribute('inert'));
 const close = named('Close preferences'), last = Array.from(document.querySelectorAll('[role="switch"]')).at(-1); last.focus(); key(last, 'Tab'); assert.equal(document.activeElement, close);
 key(close, 'Tab', { shiftKey: true }); assert.equal(document.activeElement, last);
 document.getElementById('outside').focus(); assert.equal(document.activeElement, close);
});
test('restored incoming sound exposes a direct preview before playback has been verified', () => {
 const view = scenario('conversation'); let previews = 0;
 render(h(PreferencesPanel, { preferences: { ...view.preferences, soundMode: 'incoming' }, sound: { mode: 'incoming', playback: 'unverified' }, onClose: () => {}, callbacks: {
  ...bindings().callbacks, onSoundModeChange: () => assert.fail('preview must not toggle sound'), onPreviewSound: () => previews++,
 } }));
 assert.equal(named('On').getAttribute('aria-pressed'), 'true');
 assert.equal(named('Preview').disabled, false); click(named('Preview')); assert.equal(previews, 1);
 assert.ok(document.body.textContent.includes('The next incoming message will try playback'));
});
test('only the top layer handles Escape, then focus returns to search', () => {
 const events = [];
 function Host() { const [open, setOpen] = React.useState(true); const view = scenario('conversation'); return h(React.Fragment, null,
  h(SearchPanel, { view: { phase: 'idle', query: '' }, history: view.history, onClose: () => events.push('search'), onQueryChange: () => {}, onSelectResult: () => {}, onRetry: () => {} }),
  open ? h(PreferencesPanel, { preferences: view.preferences, sound: view.sound, callbacks: bindings().callbacks, onClose: () => { events.push('preferences'); setOpen(false); } }) : null); }
 render(h(Host)); key(document.activeElement, 'Escape'); assert.deepEqual(events, ['preferences']); assert.equal(document.activeElement, document.querySelector('input'));
 key(document.activeElement, 'Escape'); assert.deepEqual(events, ['preferences', 'search']);
});
test('terminal session dialog has initial focus and background keyboard protection', () => {
 render(h(ConnectionBanner, { view: { phase: 'ended', reason: 'replaced' }, onRetry: () => {}, onReturnToJoin: () => {} }));
 assert.equal(document.activeElement, named('Back to join screen')); key(document.activeElement, 'Tab'); assert.equal(document.activeElement, named('Back to join screen'));
 key(document.activeElement, 'Escape'); assert.ok(document.querySelector('[role="alertdialog"]'));
});
test('composer forwards IME/key facts without independently submitting', () => {
 const calls = []; const b = bindings();
 render(h(ChatComposer, { view: scenario('code-composer').composer, dom: b.composerDom, callbacks: { ...b.callbacks, onComposerKey: x => { calls.push(x); return true; }, onSubmit: () => assert.fail('keyboard double submission') } }));
 act(() => Simulate.keyDown(document.querySelector('textarea'), { key: 'Enter', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false, nativeEvent: { isComposing: true, keyCode: 229 } }));
 assert.equal(calls.length, 1); assert.equal(calls[0].isComposing, true); assert.equal(calls[0].legacyKeyCode, 229);
});
function mountEditor(mode, value, isComposing = false) {
 const intents = [], keys = [], base = scenario('conversation').composer;
 let draft;
 function Host() {
  const [state, setState] = React.useState({ ...base.draft, mode, textBuffer: mode === 'text' ? value : 'Text buffer', codeBuffer: { ...base.draft.codeBuffer, source: mode === 'code' ? value : 'Code buffer' } });
  draft = state;
  return h(ChatComposer, { view: { ...base, draft: state, isComposing }, dom: bindings().composerDom, callbacks: {
   ...bindings().callbacks,
   onDraftIntent: intent => { intents.push(intent); setState(current => ({ ...current, revision: current.revision + 1, ...(intent.type === 'text.changed' ? { textBuffer: intent.value } : { codeBuffer: { ...current.codeBuffer, source: intent.value } }) })); },
   onComposerKey: input => { keys.push(input); return false; },
   onSubmit: () => assert.fail('editing must not submit'),
  } });
 }
 render(h(Host));
 const textarea = document.querySelector('textarea'); textarea.focus();
 return { textarea, intents, keys, draft: () => draft };
}
test('Tab inserts literal tabs at the caret in either mode without moving focus or changing the inactive buffer', () => {
 for (const mode of ['text', 'code']) {
  const editor = mountEditor(mode, '😀alpha'), { textarea } = editor;
  textarea.setSelectionRange(2, 2);
  assert.equal(key(textarea, 'Tab'), false);
  assert.equal(textarea.value, '😀\talpha');
  assert.equal(textarea.selectionStart, 3); assert.equal(textarea.selectionEnd, 3);
  assert.equal(document.activeElement, textarea);
  key(textarea, 'Tab'); assert.equal(textarea.value, '😀\t\talpha'); assert.equal(textarea.selectionStart, 4);
  assert.equal(editor.intents.length, 2); assert.equal(editor.keys.length, 0);
  assert.equal(editor.draft().revision, scenario('conversation').composer.draft.revision + 2);
  assert.equal(mode === 'text' ? editor.draft().codeBuffer.source : editor.draft().textBuffer, mode === 'text' ? 'Code buffer' : 'Text buffer');
  assert.ok(document.getElementById(textarea.getAttribute('aria-describedby')).textContent.includes('Esc then Tab moves focus'));
 }
});
test('Tab replaces the selected text and preserves the textarea scroll position', () => {
 for (const mode of ['text', 'code']) {
  const { textarea } = mountEditor(mode, 'first\nreplace\nlast');
  textarea.setSelectionRange(6, 13); textarea.scrollTop = 42; textarea.scrollLeft = 17;
  key(textarea, 'Tab'); assert.equal(textarea.value, 'first\n\t\nlast');
  assert.equal(textarea.selectionStart, 7); assert.equal(textarea.selectionEnd, 7);
  assert.equal(textarea.scrollTop, 42); assert.equal(textarea.scrollLeft, 17);
 }
});
test('composition and modified Tab events retain their native behavior', () => {
 for (const mode of ['text', 'code']) {
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
   const editor = mountEditor(mode, 'content');
   assert.equal(key(editor.textarea, 'Tab', options), true);
   assert.equal(editor.textarea.value, 'content'); assert.equal(editor.intents.length, 0);
  }
  const composing = mountEditor(mode, 'content', true);
  assert.equal(key(composing.textarea, 'Tab'), true); assert.equal(composing.intents.length, 0);
 }
});
test('Escape releases the next Tab for focus navigation and ordinary editing resumes afterward', () => {
 const { textarea } = mountEditor('code', 'content');
 textarea.setSelectionRange(0, 0);
 key(textarea, 'Escape'); assert.equal(key(textarea, 'Tab'), true); assert.equal(textarea.value, 'content');
 assert.equal(key(textarea, 'Tab'), false); assert.equal(textarea.value, '\tcontent');
 key(textarea, 'Escape'); key(textarea, 'ArrowRight'); assert.equal(key(textarea, 'Tab'), false);
 key(textarea, 'Escape'); act(() => document.getElementById('outside').focus()); textarea.focus();
 assert.equal(key(textarea, 'Tab'), false);
});
test('plain messages preserve asterisks and grouping shares only the author header', () => {
 const b = bindings(), timeline = scenario('conversation').timeline;
 const sample = timeline.items.find(item => item.type === 'message');
 const text = '**Here** I am';
 const first = { ...sample, key: 'first', message: { ...sample.message, key: 'first', content: { kind: 'text', text }, grouping: 'start', searchMatches: [] } };
 const second = { ...first, key: 'second', message: { ...first.message, key: 'second', grouping: 'continuation' } };
 render(h(MessageList, { view: { ...timeline, items: [first, second] }, dom: b.timelineDom, callbacks: b.callbacks }));
 const rows = document.querySelectorAll('ol > li');
 assert.equal(rows.length, 2); assert.equal(rows[0].querySelector('p').textContent, text); assert.equal(rows[1].querySelector('p').textContent, text);
 assert.equal(rows[0].querySelectorAll('time').length, 1); assert.equal(rows[1].querySelectorAll('time').length, 0);
 assert.equal(document.querySelectorAll('p strong, p em').length, 0);
 assert.ok(rows[0].querySelector('[aria-label^="Reply to"]')); assert.ok(rows[1].querySelector('[aria-label^="Reply to"]'));
});
test('message and member timestamps adapt to message age', () => {
 const now = Date.parse('2026-10-24T12:00:00.000Z');
 assert.match(formatMessageTime(now - 2 * 60 * 60 * 1000, now), /^\d{2}:\d{2}$/);
 assert.equal(formatMessageTime(now - 24 * 60 * 60 * 1000, now), '1 day ago');
 assert.equal(formatMessageTime(now - 5 * 24 * 60 * 60 * 1000, now), '5 days ago');
 assert.equal(formatMessageTime(now - 7 * 24 * 60 * 60 * 1000, now), formatDateTime(now - 7 * 24 * 60 * 60 * 1000));
});
test('preview composer respects byte limits, UTF-8, offline, and outbox locks', () => {
 const chat = scenario('conversation'), base = chat.composer;
 const draft = { ...base.draft, textBuffer: 'x'.repeat(16384) };
 assert.equal(projectPreviewComposer(base, draft, 'enter', chat.connection).canSubmit, true);
 assert.equal(projectPreviewComposer(base, { ...draft, textBuffer: 'x'.repeat(16385) }, 'enter', chat.connection).disabledReason, 'too-large');
 assert.equal(projectPreviewComposer(base, { ...draft, textBuffer: '😀'.repeat(4097) }, 'enter', chat.connection).disabledReason, 'too-large');
 assert.equal(projectPreviewComposer(base, draft, 'enter', { phase: 'offline', canRetry: false }).canSubmit, false);
 assert.equal(projectPreviewComposer({ ...base, disabledReason: 'outbox-full' }, draft, 'enter', chat.connection).disabledReason, 'outbox-full');
});
test('preview sends and hints use the same selected shortcut; oversized input is locked', () => {
 render(h(PreviewHost)); act(() => Simulate.change(document.querySelector('textarea'), { target: { value: 'hello' } }));
 click(named('Open preferences')); click(named('Ctrl/⌘+Enter to send')); click(named('Close preferences'));
 assert.ok(document.querySelector('[title="Change send shortcut"]').textContent.startsWith('Ctrl/⌘+Enter'));
 act(() => Simulate.change(document.querySelector('textarea'), { target: { value: 'x'.repeat(20000) } })); assert.equal(named('Send').disabled, true);
});
test('composer keeps an expired reply summary and cancel removes the reply strip', () => {
 window.history.replaceState(null, '', '/preview.html?scenario=reply-composer-expired'); render(h(PreviewHost));
 assert.ok(document.getElementById('root').textContent.includes('export function preview'));
 click(named('Cancel reply')); assert.equal(named('Cancel reply'), undefined);
});
test('outbox-to-canonical confirmation keeps the same row DOM identity', () => {
 const b = bindings(), timeline = scenario('unknown').timeline, pending = timeline.items.find(x => x.type === 'message' && x.message.identity.kind === 'outbox');
 render(h(MessageList, { view: { ...timeline, items: [pending] }, dom: b.timelineDom, callbacks: b.callbacks })); const before = document.querySelector('ol>li');
 const canonical = { ...pending, message: { ...pending.message, identity: { kind: 'canonical', messageId: 'm-1', sequence: 9 }, delivery: { phase: 'confirmed' } } };
 render(h(MessageList, { view: { ...timeline, items: [canonical] }, dom: b.timelineDom, callbacks: b.callbacks })); assert.equal(document.querySelector('ol>li'), before);
});
test('raw code stays literal and denied copy never reports success', async () => {
 const source = '\t<script>alert("text")</script>\n**literal**\n';
 render(h(CodeBlock, { source, language: 'html', matches: [], onCopy: () => Promise.resolve({ ok: false, reason: 'denied' }) }));
 assert.equal(document.querySelector('pre code').textContent, source); assert.equal(document.querySelector('pre script'), null);
 await act(async () => { named('Copy html code').click(); await Promise.resolve(); });
 assert.ok(document.getElementById('root').textContent.includes('Copy failed')); assert.ok(!document.getElementById('root').textContent.includes('Copied'));
});
test('preview clipboard does not claim success when clipboard support is absent', async () => {
 assert.deepEqual(await bindings().callbacks.onCopyCode('raw'), { ok: false, reason: 'unavailable' });
});
test('every English fixture renders without errors; scenarios and row keys are unique', () => {
 assert.equal(new Set(PREVIEW_SCENARIOS.map(s => s.id)).size, PREVIEW_SCENARIOS.length);
 const b = bindings();
 for (const entry of PREVIEW_SCENARIOS) {
  if (entry.view.screen === 'chat') { const view = entry.view.chat; assert.equal(new Set(view.timeline.items.map(i => i.key)).size, view.timeline.items.length); render(h(ChatScreen, { view, callbacks: b.callbacks, timelineDom: b.timelineDom, composerDom: b.composerDom })); }
  else render(h(JoinScreen, { view: entry.view.join, onSubmit: () => {}, onDisplayNameChange: () => {} }));
  assert.equal(/[\u4e00-\u9fff]/u.test(document.body.textContent), false, entry.id); render(null);
 }
});
test('StrictMode lifecycle leaves one working focus layer and restores inert state', () => {
 document.getElementById('outside').focus(); render(h(React.StrictMode, null, h(PrefHost)));
 assert.ok(document.getElementById('root').hasAttribute('inert'));
 const on = named('On'); on.focus(); click(on); assert.equal(document.activeElement, on);
 render(null); assert.equal(document.querySelectorAll('[inert]').length, 0); assert.equal(document.activeElement, document.getElementById('outside'));
});

test('optional admin password stays controlled and guest entry remains available', () => {
 let password = '', submits = 0;
 function Host() { const [value, setValue] = React.useState(''); return h(JoinScreen, { view: { displayName: 'Alice', adminPassword: value, phase: 'idle', error: null }, onDisplayNameChange: () => {}, onAdminPasswordChange: value => { password = value; setValue(value); }, onSubmit: () => submits++ }); }
 render(h(Host));
 const input = document.querySelector('input[type="password"]'); assert.equal(input.value, ''); assert.equal(named('Join room').disabled, false);
 assert.ok(document.body.textContent.includes('Leave empty to join as a guest'));
 act(() => Simulate.change(input, { target: { value: 'room-secret' } })); assert.equal(password, 'room-secret'); assert.equal(input.value, 'room-secret');
 act(() => Simulate.submit(document.querySelector('form'))); assert.equal(submits, 1);
});
test('public pin remains visible to guests while pin mutations require administration', () => {
 const base = scenario('conversation'), b = bindings(), message = base.timeline.items.find(item => item.type === 'message').message;
 const calls = [];
 render(h(PinnedMessagePanel, { message, canManage: false, pending: false, onJump: id => calls.push(id), onSetPin: () => assert.fail('guest pin mutation') }));
 assert.ok(document.querySelector('[aria-label="Pinned message"]')); assert.equal(named('Unpin message'), undefined); click(named('View pinned message')); assert.ok(document.querySelector('[aria-label="Pinned message details"]')); click(named('Close pinned message')); click(named('Jump to pinned message')); assert.deepEqual(calls, [message.identity.messageId]);
 render(h(PinnedMessagePanel, { message, canManage: true, pending: true, onJump: () => {}, onSetPin: () => assert.fail('pending mutation') })); assert.equal(named('Unpin message').disabled, true);
 render(h(MessageRow, { view: { ...message, actions: { ...message.actions, canPin: false } }, registerNode: () => {}, callbacks: b.callbacks })); assert.equal(named(`Pin message from ${message.author.displayName}`), undefined);
 render(h(MessageRow, { view: { ...message, actions: { ...message.actions, canPin: true } }, registerNode: () => {}, callbacks: { ...b.callbacks, onSetPin: id => calls.push(id) } })); click(named(`Pin message from ${message.author.displayName}`)); assert.equal(calls.at(-1), message.identity.messageId);
});
test('folding changes presentation while code copy preserves the complete literal source', async () => {
 const base = scenario('conversation').timeline.items.find(item => item.type === 'message').message, b = bindings();
 const source = Array.from({ length: 30 }, (_, index) => `\tconst value${index} = "**literal**";`).join('\n') + '\n'; let copied;
 function Host() { const [expanded, setExpanded] = React.useState(false); return h(MessageRow, { view: { ...base, content: { kind: 'code', language: 'typescript', source }, fold: { collapsible: true, expanded } }, registerNode: () => {}, callbacks: { ...b.callbacks, onToggleExpanded: key => { assert.equal(key, base.key); setExpanded(value => !value); }, onCopyCode: async value => { copied = value; return { ok: true }; } } }); }
 render(h(Host)); assert.equal(named('Show more').getAttribute('aria-expanded'), 'false'); assert.ok(document.querySelector('pre.cr-folded-code'));
 await act(async () => { named('Copy typescript code').click(); await Promise.resolve(); }); assert.equal(copied, source); assert.equal(document.querySelector('pre code').textContent, source);
 click(named('Show more')); assert.equal(named('Show less').getAttribute('aria-expanded'), 'true'); assert.equal(document.querySelector('pre.cr-folded-code'), null);
 click(named('Show less')); assert.ok(document.querySelector('pre.cr-folded-code'));
});
test('reading size and member sound controls keep focus and report controlled preferences', () => {
 const base = scenario('conversation'), b = bindings(); let members = true, size = 'standard';
 function Host() { const [preferences, setPreferences] = React.useState({ ...base.preferences, memberSounds: true, readingSize: 'standard' }); return h(PreferencesPanel, { preferences, sound: base.sound, onClose: () => {}, callbacks: { ...b.callbacks, onReadingSizeChange: value => { size = value; setPreferences(current => ({ ...current, readingSize: value })); }, onMemberSoundsChange: value => { members = value; setPreferences(current => ({ ...current, memberSounds: value })); } } }); }
 render(h(Host)); const larger = named('Larger'); larger.focus(); click(larger); assert.equal(size, 'larger'); assert.equal(document.activeElement, larger); assert.equal(larger.getAttribute('aria-pressed'), 'true');
 const memberSwitch = document.querySelector('[role="switch"][aria-labelledby="pref-member-sounds"]'); assert.equal(memberSwitch.getAttribute('aria-checked'), 'true'); click(memberSwitch); assert.equal(members, false); assert.equal(memberSwitch.getAttribute('aria-checked'), 'false');
 render(h(ChatScreen, { view: { ...base, preferences: { ...base.preferences, readingSize: 'larger' } }, callbacks: b.callbacks, timelineDom: b.timelineDom, composerDom: b.composerDom })); assert.ok(document.querySelector('[data-reading-size="larger"]'));
});
test('bookmark actions use canonical identity and retain local selection state', () => {
 const base = scenario('conversation').timeline.items.find(item => item.type === 'message').message, b = bindings(), calls = [];
 render(h(MessageRow, { view: { ...base, bookmarked: true }, registerNode: () => {}, callbacks: { ...b.callbacks, onToggleBookmark: id => calls.push(id) } }));
 const action = named(`Bookmark message from ${base.author.displayName}`); assert.equal(action.getAttribute('aria-pressed'), 'true'); click(action); assert.deepEqual(calls, [base.identity.messageId]);
 render(h(MessageRow, { view: { ...base, identity: { kind: 'outbox', operationId: 'operation' }, bookmarked: false }, registerNode: () => {}, callbacks: b.callbacks })); assert.equal(named(`Bookmark message from ${base.author.displayName}`), undefined);
});
test('bookmark snapshots remain readable and copyable after the source expires', async () => {
 const base = scenario('conversation').timeline.items.find(item => item.type === 'message').message;
 const source = '\t**literal**\n' + 'entry '.repeat(180) + 'complete snapshot end'; let copied, cleared = 0;
 const item = { id: 'saved-message', author: base.author, content: { kind: 'code', language: 'plaintext', source }, createdAt: base.createdAt, savedAt: base.createdAt, sourceAvailable: false };
 const props = { onClose: () => {}, onRemove: () => {}, onClear: () => cleared++, onJump: () => assert.fail('expired source jump'), onCopy: async value => { copied = value; return { ok: true }; } };
 document.getElementById('outside').focus(); render(h(BookmarksPanel, { ...props, view: { open: true, items: [item] } }));
 assert.equal(document.activeElement, named('Close bookmarks')); assert.equal(named(`View source from ${base.author.displayName}`).disabled, true);
 click(named('Show full bookmark')); assert.equal(document.querySelector('pre code').textContent, source);
 await act(async () => { named(`Copy bookmark from ${base.author.displayName}`).click(); await Promise.resolve(); }); assert.equal(copied, source); assert.ok(document.body.textContent.includes('Copied'));
 click(named('Clear all')); assert.equal(cleared, 0); click(named('Clear bookmarks')); assert.equal(cleared, 1);
 render(h(BookmarksPanel, { ...props, view: { open: true, items: [] } })); assert.ok(document.body.textContent.includes('No saved bookmarks')); assert.equal(named('Clear all'), undefined);
 render(h(BookmarksPanel, { ...props, view: { open: false, items: [] } })); assert.equal(document.activeElement, document.getElementById('outside'));
});
test('member activity is quiet, bounded and distinguishes joins, departures and returns', () => {
 render(h(MemberActivity, { items: [{ id: '1', displayName: 'Older', kind: 'joined' }, { id: '2', displayName: 'Alice', kind: 'joined' }, { id: '3', displayName: 'Bob', kind: 'left' }, { id: '4', displayName: 'Chen', kind: 'returned' }] }));
 const status = document.querySelector('[role="status"][aria-label="Member activity"]'); assert.ok(status.textContent.includes('Alice joined')); assert.ok(status.textContent.includes('Bob left')); assert.ok(status.textContent.includes('Chen returned')); assert.equal(status.textContent.includes('Older'), false);
});

test('expired pinned snapshots open in a focused dialog while jump stays unavailable', async () => {
 const base = scenario('conversation').timeline.items.find(item => item.type === 'message').message;
 const source = '\tconst literal = "**raw**";\n' + 'code '.repeat(400); let copied;
 render(h(PinnedMessagePanel, { message: { ...base, content: { kind: 'code', language: 'javascript', source } }, canManage: false, pending: false, sourceAvailable: false, onJump: () => assert.fail('expired jump'), onSetPin: () => assert.fail('guest mutation'), onCopy: async value => { copied = value; return { ok: true }; } }));
 const trigger = named('View pinned message'); trigger.focus(); click(trigger); assert.equal(document.activeElement, named('Close pinned message')); assert.equal(document.querySelector('[aria-label="Pinned message details"] pre code').textContent, source);
 const jump = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Jump to pinned message'); assert.equal(jump.disabled, true);
 await act(async () => { named('Copy javascript code').click(); await Promise.resolve(); }); assert.equal(copied, source);
 key(document.activeElement, 'Escape'); assert.equal(document.querySelector('[aria-label="Pinned message details"]'), null); assert.equal(document.activeElement, trigger);
});

test('saved identity can be declined without changing administrator authentication', () => {
 let choice = true;
 function Host() { const [saved, setSaved] = React.useState(true); return h(JoinScreen, { view: { displayName: 'Alice', adminPassword: 'room-secret', restoreAvailable: true, useSavedIdentity: saved, phase: 'idle', error: null }, onDisplayNameChange: () => {}, onAdminPasswordChange: () => {}, onUseSavedIdentityChange: value => { choice = value; setSaved(value); }, onSubmit: () => {} }); }
 render(h(Host)); const checkbox = document.querySelector('input[type="checkbox"]'); assert.equal(checkbox.checked, true); assert.ok(document.body.textContent.includes('Use saved guest identity')); assert.ok(document.body.textContent.includes('Turn off to join as a different guest.'));
 click(checkbox); assert.equal(choice, false); assert.equal(checkbox.checked, false); assert.equal(document.querySelector('input[type="password"]').value, 'room-secret'); assert.equal(named('Join room').disabled, false);
 render(h(JoinScreen, { view: { displayName: '', phase: 'idle', error: null }, onDisplayNameChange: () => {}, onSubmit: () => {} })); assert.equal(document.querySelector('input[type="checkbox"]'), null);
});

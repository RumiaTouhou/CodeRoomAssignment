import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClientEvent, parseClientJson, parseServerEvent, parseServerJson,
  parseCreateSession, parseSessionCredential, parseSearchRequest, parseSearchResponse,
  snapshotInvariantErrors, messageRenderKey, rawContent, LIMITS, utf8Bytes,
} from '../shared/index.js';
import {
  ALICE, BOB, SAMPLE_EPOCH, SAMPLE_NOW, SAMPLE_CREDENTIAL, SAMPLE_MESSAGES, SAMPLE_SNAPSHOT,
  SAMPLE_SEARCH, RAW_CODE, fixtureId, snapshotFor,
} from './fixtures/messages.js';
import { SAMPLE_SCENARIOS } from './fixtures/scenarios.js';
import { SAMPLE_TRANSCRIPT } from './fixtures/events.js';

const validSend = {
  v: 1, type: 'message.send', requestId: fixtureId(600), epochId: SAMPLE_EPOCH,
  payload: { operationId: fixtureId(601), roomId: 'lobby', content: { kind: 'text', text: 'hello **raw**' }, replyToId: null },
};
const clone = () => structuredClone(validSend);
const rejects = [
  ['unknown event', x => { x.type = 'message.delete'; }],
  ['unsupported version', x => { x.v = 2; }],
  ['missing epoch', x => { delete x.epochId; }],
  ['unknown top-level field', x => { x.author = ALICE; }],
  ['forged sender in payload', x => { x.payload.senderId = BOB.id; }],
  ['forged timestamp', x => { x.payload.createdAt = 123; }],
  ['client-created canonical ID', x => { x.payload.messageId = fixtureId(8); }],
  ['invalid request UUID', x => { x.requestId = 'temp-1'; }],
  ['invalid operation UUID', x => { x.payload.operationId = 'temp-op'; }],
  ['missing reply field', x => { delete x.payload.replyToId; }],
  ['invalid reply ID', x => { x.payload.replyToId = 20; }],
  ['wrong room', x => { x.payload.roomId = 'private'; }],
  ['blank text', x => { x.payload.content.text = '  \n\t'; }],
  ['HTML field not allowed', x => { x.payload.content.html = '<b>x</b>'; }],
  ['mixed content kinds', x => { x.payload.content.source = 'x'; }],
  ['oversize text', x => { x.payload.content.text = 'a'.repeat(LIMITS.messageBodyUtf8Bytes + 1); }],
  ['UTF-8 limit is not JS string length', x => { x.payload.content.text = '😀'.repeat(4097); }],
  ['NUL not accepted', x => { x.payload.content.text = 'a\0b'; }],
  ['unsupported code language', x => { x.payload.content = { kind: 'code', source: 'x', language: 'arbitrary-plugin' }; }],
  ['empty code', x => { x.payload.content = { kind: 'code', source: '', language: 'plaintext' }; }],
];
for (const [name, mutate] of rejects) test(`input boundary: ${name}`, () => {
  const value = clone(); mutate(value);
  assert.equal(parseClientEvent(value).ok, false);
});
test('valid logical send is accepted without content transformation', () => {
  const parsed = parseClientJson(JSON.stringify(validSend));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.payload.content.text, 'hello **raw**');
});
test('code retains tabs, trailing newline, stars and HTML-like text', () => {
  const value = clone(); value.payload.content = { kind: 'code', source: RAW_CODE, language: 'typescript' };
  const parsed = parseClientEvent(value);
  assert.equal(parsed.ok, true); assert.equal(rawContent(parsed.value.payload.content), RAW_CODE);
});
test('whitespace around nonblank text is preserved', () => {
  const value = clone(); value.payload.content.text = '  keep this\n';
  assert.equal(parseClientEvent(value).value.payload.content.text, '  keep this\n');
});
test('payload byte boundary is inclusive', () => {
  const value = clone(); value.payload.content.text = 'a'.repeat(LIMITS.messageBodyUtf8Bytes);
  assert.equal(parseClientEvent(value).ok, true);
});
test('invalid JSON and oversized frames fail safely', () => {
  assert.equal(parseClientJson('{').ok, false);
  assert.equal(parseClientJson(' '.repeat(LIMITS.clientFrameUtf8Bytes + 1)).ok, false);
  assert.equal(parseClientEvent(null).ok, false);
  assert.equal(parseClientEvent([]).ok, false);
});
test('prototype-named fields are rejected', () => {
  const value = JSON.parse(JSON.stringify(validSend).replace('"v":1', '"v":1,"__proto__":{}'));
  assert.equal(parseClientEvent(value).ok, false);
});
test('all transcript frames validate', () => {
  for (const step of SAMPLE_TRANSCRIPT) {
    const parsed = step.direction === 'client-to-server' ? parseClientJson(JSON.stringify(step.event)) : parseServerJson(JSON.stringify(step.event));
    assert.equal(parsed.ok, true, `${step.event.type}: ${parsed.issue}`);
  }
});
test('all remaining client variants validate', () => {
  const common = { v: 1, requestId: fixtureId(700), epochId: SAMPLE_EPOCH };
  for (const event of [
    { ...common, type: 'room.sync', payload: { roomId: 'lobby' } },
    { ...common, type: 'reaction.set', payload: { roomId: 'lobby', operationId: fixtureId(701), messageId: SAMPLE_MESSAGES[0].id, emoji: '✅', active: true } },
    { ...common, type: 'typing.set', payload: { roomId: 'lobby', active: false } },
  ]) assert.equal(parseClientEvent(event).ok, true);
});
test('typing does not leak draft contents or allow a forged user', () => {
  for (const extra of [{ text: 'secret draft' }, { userId: BOB.id }]) {
    assert.equal(parseClientEvent({ v: 1, requestId: fixtureId(710), epochId: SAMPLE_EPOCH, type: 'typing.set', payload: { roomId: 'lobby', active: true, ...extra } }).ok, false);
  }
});
test('reaction requests must express explicit boolean target state', () => {
  const event = { v: 1, requestId: fixtureId(711), epochId: SAMPLE_EPOCH, type: 'reaction.set', payload: { roomId: 'lobby', operationId: fixtureId(712), messageId: SAMPLE_MESSAGES[0].id, emoji: '✅', active: 'toggle' } };
  assert.equal(parseClientEvent(event).ok, false);
});
test('all remaining server variants validate', () => {
  const common = { v: 1, epochId: SAMPLE_EPOCH, serverTime: SAMPLE_NOW };
  const events = [
    { ...common, type: 'room.snapshot', requestId: fixtureId(720), payload: { snapshot: SAMPLE_SNAPSHOT } },
    { ...common, type: 'presence.state', payload: SAMPLE_SNAPSHOT.presence },
    { ...common, type: 'session.ended', payload: { reason: 'replaced' } },
    { ...common, type: 'reaction.accepted', requestId: fixtureId(721), payload: { operationId: fixtureId(722), messageId: SAMPLE_MESSAGES[0].id, emoji: '✅', active: true, changed: true, appliedRevision: 11, duplicate: false, retained: true } },
    { ...common, type: 'request.error', payload: { requestId: fixtureId(723), operationId: null, error: { code: 'RATE_LIMITED', message: 'Slow down', retryable: true, outcome: 'not-applied', retryAfterMs: 1000 } } },
  ];
  for (const event of events) { const p = parseServerEvent(event); assert.equal(p.ok, true, p.issue); }
});
test('duplicate reaction membership cannot inflate count', () => {
  const value = { v: 1, type: 'room.snapshot', epochId: SAMPLE_EPOCH, serverTime: SAMPLE_NOW, requestId: fixtureId(724), payload: { snapshot: structuredClone(SAMPLE_SNAPSHOT) } };
  value.payload.snapshot.messages[2].reactions[0].userIds.push(BOB.id);
  assert.equal(parseServerEvent(value).ok, false);
});
test('session request only accepts a nickname, normalizes it, and rejects bidi controls', () => {
  assert.deepEqual(parseCreateSession({ displayName: '  Alice  ' }), { ok: true, value: { displayName: 'Alice' } });
  assert.equal(parseCreateSession({ displayName: 'Alice', userId: ALICE.id }).ok, false);
  assert.equal(parseCreateSession({ displayName: '\u202EAlice' }).ok, false);
  assert.equal(parseCreateSession({ displayName: 'a'.repeat(25) }).ok, false);
});
test('session fixture validates without exposing token in UI', () => {
  assert.equal(parseSessionCredential(SAMPLE_CREDENTIAL).ok, true);
  assert.equal(JSON.stringify(SAMPLE_SCENARIOS).includes('bearerToken'), false);
});
test('search request is bounded and does not imply regex syntax', () => {
  assert.deepEqual(parseSearchRequest({ query: '  [ACK]  ', limit: 50 }).value, { query: '[ACK]', limit: 50 });
  assert.equal(parseSearchRequest({ query: 'x', limit: 51 }).ok, false);
  assert.equal(parseSearchRequest({ query: '', limit: 50 }).ok, false);
});
test('search fixture validates and ranges select exact substrings', () => {
  assert.equal(parseSearchResponse(SAMPLE_SEARCH).ok, true);
  for (const hit of SAMPLE_SEARCH.results) for (const range of hit.matches) assert.equal(hit.snippet.slice(range.start, range.end), 'ACK');
});
test('invalid highlight offsets are rejected', () => {
  const response = structuredClone(SAMPLE_SEARCH); response.results[0].matches[0].end = 10000;
  assert.equal(parseSearchResponse(response).ok, false);
});
test('baseline and empty snapshots satisfy semantic invariants', () => {
  assert.deepEqual(snapshotInvariantErrors(SAMPLE_SNAPSHOT), []);
  assert.deepEqual(snapshotInvariantErrors(snapshotFor([], 0)), []);
});
test('duplicate logical send is detected by invariants', () => {
  const duplicate = { ...SAMPLE_MESSAGES[0], id: fixtureId(9999), sequence: 99 };
  const snapshot = snapshotFor([...SAMPLE_MESSAGES, duplicate], 100);
  assert.ok(snapshotInvariantErrors(snapshot).includes('duplicate logical send'));
});
test('stale or cross-epoch snapshots fail semantic checks', () => {
  const snapshot = structuredClone(SAMPLE_SNAPSHOT);
  snapshot.messages[0].epochId = fixtureId(12345);
  assert.ok(snapshotInvariantErrors(snapshot).includes('message belongs to another room epoch'));
});
test('canonical and optimistic message use the same React key', () => {
  const message = SAMPLE_MESSAGES[0];
  assert.equal(messageRenderKey(message), messageRenderKey({ author: message.author, clientOperationId: message.clientOperationId }));
});
test('all UI scenarios have unique names and stable row keys', () => {
  assert.equal(new Set(SAMPLE_SCENARIOS.map(s => s.id)).size, SAMPLE_SCENARIOS.length);
  for (const scenario of SAMPLE_SCENARIOS) if (scenario.view.screen === 'chat') {
    const keys = scenario.view.chat.timeline.items.map(item => item.key);
    assert.equal(new Set(keys).size, keys.length, scenario.id);
  }
});
test('fixed data stays inside history and snapshot size budgets', () => {
  assert.ok(SAMPLE_SNAPSHOT.history.serializedBytes <= LIMITS.historyJsonUtf8Bytes);
  assert.ok(utf8Bytes(JSON.stringify(SAMPLE_SNAPSHOT)) <= LIMITS.snapshotFrameUtf8Bytes);
});
test('retry transcript reuses logical ID but changes request ID; no second creation', () => {
  const sends = SAMPLE_TRANSCRIPT.filter(s => s.event.type === 'message.send').map(s => s.event);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].payload.operationId, sends[1].payload.operationId);
  assert.notEqual(sends[0].requestId, sends[1].requestId);
  assert.equal(SAMPLE_TRANSCRIPT.filter(s => s.event.type === 'room.delta' && s.event.payload.change.kind === 'message.created').length, 1);
});

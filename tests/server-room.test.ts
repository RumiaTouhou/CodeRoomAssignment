import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Room, RoomError } from "../server/room.js";
import type { PublicUser, SendMessageInput, SetReactionInput } from "../shared/domain.js";
import { LIMITS } from "../shared/limits.js";
import { snapshotInvariantErrors } from "../shared/invariants.js";
import { parseSearchResponse, parseServerEvent } from "../shared/validation.js";

const user = (name = "Alice"): PublicUser => ({ id: randomUUID(), displayName: name, avatarSeed: name });
const sendInput = (text = "Hello"): SendMessageInput => ({ operationId: randomUUID(), roomId: "lobby", content: { kind: "text", text }, replyToId: null });
const reactionInput = (messageId: string, active = true): SetReactionInput => ({ operationId: randomUUID(), roomId: "lobby", messageId, emoji: "✅", active });
const snapshot = (room: Room) => room.snapshot({ version: 0, members: [] }, { version: 0, entries: [] });
const expectCode = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => error instanceof RoomError && error.problem.code === code);

test("room preserves raw content and creates authoritative immutable message facts", () => {
  const room = new Room({ clock: () => 123 });
  const alice = user();
  const text = '\t**literal**\n<script>plain text</script>\n';
  const input: SendMessageInput = { ...sendInput(), content: { kind: "code", source: text, language: "html" } };
  const result = room.send(alice, input);
  assert.equal(room.messages[0]?.author.id, alice.id);
  assert.deepEqual(room.messages[0]?.content, input.content);
  assert.equal(room.messages[0]?.createdAt, 123);
  assert.equal(room.messages[0]?.sequence, 1);
  assert.equal(result.receipt.appliedRevision, 1);
  assert.ok(Object.isFrozen(room.messages));
  assert.ok(Object.isFrozen(room.messages[0]?.content));
  assert.deepEqual(snapshotInvariantErrors(snapshot(room)), []);
});

test("same logical send returns a duplicate receipt without creating another message", () => {
  const room = new Room(); const alice = user(); const input = sendInput();
  const first = room.send(alice, input); const duplicate = room.send(alice, { ...input });
  assert.equal(duplicate.delta, null); assert.equal(duplicate.receipt.duplicate, true);
  assert.equal(duplicate.receipt.messageId, first.receipt.messageId);
  assert.equal(room.revision, 1); assert.equal(room.messages.length, 1);
  assert.equal(room.hasOperation(alice.id, input.operationId), true);
});

test("operation IDs cannot be reused with changed payloads or another operation kind", () => {
  const room = new Room(); const alice = user(); const input = sendInput(); const first = room.send(alice, input);
  expectCode(() => room.send(alice, { ...input, content: { kind: "text", text: "changed" } }), "OPERATION_ID_CONFLICT");
  expectCode(() => room.react(alice, { ...reactionInput(first.receipt.messageId), operationId: input.operationId }), "OPERATION_ID_CONFLICT");
  const bob = user("Bob"); room.send(bob, input); assert.equal(room.messages.length, 2);
});

test("quotes are server-built snapshots and missing targets reject without mutation", () => {
  const room = new Room(); const alice = user(); const bob = user("Bob");
  const original = room.send(alice, sendInput("👩🏽‍💻".repeat(100)));
  const reply = room.send(bob, { ...sendInput("quoted"), replyToId: original.receipt.messageId });
  const quote = room.messages.find(message => message.id === reply.receipt.messageId)?.reply;
  assert.equal(quote?.author.id, alice.id); assert.equal(quote?.messageId, original.receipt.messageId);
  assert.ok(Array.from(quote?.previewText ?? "").length <= LIMITS.quotePreviewCodePoints);
  const revision = room.revision;
  expectCode(() => room.send(bob, { ...sendInput(), replyToId: randomUUID() }), "MESSAGE_NOT_FOUND");
  assert.equal(room.revision, revision);
});

test("reaction sets are idempotent and successful no-ops do not increase revision", () => {
  const room = new Room(); const alice = user(); const bob = user("Bob");
  const messageId = room.send(alice, sendInput()).receipt.messageId;
  const input = reactionInput(messageId); const first = room.react(bob, input);
  assert.equal(first.receipt.changed, true); assert.equal(room.revision, 2);
  const retry = room.react(bob, input); assert.equal(retry.delta, null); assert.equal(retry.receipt.duplicate, true);
  const noop = room.react(bob, reactionInput(messageId)); assert.equal(noop.receipt.changed, false); assert.equal(noop.delta, null); assert.equal(room.revision, 2);
  room.react(alice, reactionInput(messageId)); assert.equal(room.messages[0]?.reactions[0]?.userIds.length, 2);
  room.react(bob, reactionInput(messageId, false)); assert.deepEqual(room.messages[0]?.reactions[0]?.userIds, [alice.id]);
  room.react(alice, reactionInput(messageId, false)); assert.deepEqual(room.messages[0]?.reactions, []);
});

test("reaction membership has a bounded unique participant set", () => {
  const room = new Room(); const alice = user(); const messageId = room.send(alice, sendInput()).receipt.messageId;
  for (let i = 0; i < LIMITS.reactionUsersPerEmoji; i += 1) room.react(user(String(i)), reactionInput(messageId));
  expectCode(() => room.react(user("overflow"), reactionInput(messageId)), "REACTION_LIMIT");
  assert.equal(room.messages[0]?.reactions[0]?.userIds.length, LIMITS.reactionUsersPerEmoji);
});

test("history count eviction retains receipts and quote context without retaining old messages", () => {
  const room = new Room(); const alice = user(); const input = sendInput("old"); const first = room.send(alice, input);
  const replyId = room.send(alice, { ...sendInput("reply"), replyToId: first.receipt.messageId }).receipt.messageId;
  for (let i = 0; i < LIMITS.historyMessages - 1; i += 1) room.send(alice, sendInput(String(i)));
  assert.equal(room.messages.length, LIMITS.historyMessages);
  assert.ok(!room.messages.some(message => message.id === first.receipt.messageId));
  assert.equal(room.messages.find(message => message.id === replyId)?.reply?.previewText, "old");
  const replay = room.send(alice, input); assert.equal(replay.receipt.retained, false); assert.equal(replay.delta, null);
  expectCode(() => room.send(alice, { ...sendInput(), replyToId: first.receipt.messageId }), "MESSAGE_NOT_FOUND");
  assert.deepEqual(snapshotInvariantErrors(snapshot(room)), []);
});

test("serialized history budget evicts before the message count limit", () => {
  const room = new Room(); const alice = user(); const input = sendInput("a".repeat(LIMITS.messageBodyUtf8Bytes));
  for (let i = 0; i < 80; i += 1) room.send(alice, { ...input, operationId: randomUUID() });
  assert.ok(room.messages.length < 80); assert.ok(room.history().serializedBytes <= LIMITS.historyJsonUtf8Bytes);
  assert.deepEqual(snapshotInvariantErrors(snapshot(room)), []);
});

test("accepted-operation limit rejects new work while retries remain available", () => {
  const room = new Room(); const alice = user(); const first = sendInput("first"); room.send(alice, first);
  for (let i = 1; i < LIMITS.acceptedOperationsPerSession; i += 1) room.send(alice, sendInput(String(i)));
  expectCode(() => room.send(alice, sendInput("overflow")), "SESSION_WRITE_LIMIT");
  assert.equal(room.send(alice, first).receipt.duplicate, true);
  room.forgetUser(alice.id); assert.equal(room.hasOperation(alice.id, first.operationId), false);
});

test("search matches literal text case-insensitively and returns newest messages first", () => {
  const room = new Room(); const alice = user();
  room.send(alice, sendInput("literal [Ack].* in text")); room.send(alice, sendInput("ACK"));
  const second = room.send(alice, sendInput("ack again"));
  assert.equal(room.search("[Ack].*", 50).totalMatches, 1);
  const result = room.search(" ACK ", 1);
  assert.equal(result.query, "ACK"); assert.equal(result.totalMatches, 3); assert.equal(result.truncated, true);
  assert.equal(result.results[0]?.messageId, second.receipt.messageId);
  for (const hit of result.results) for (const range of hit.matches) assert.match(hit.snippet.slice(range.start, range.end), /^ack$/iu);
  assert.equal(parseSearchResponse(result).ok, true);
});

test("search snippets preserve code points and highlight UTF-16 offsets into original text", () => {
  const room = new Room(); const alice = user();
  room.send(alice, sendInput("😀".repeat(140) + "Kelvin 😀 target " + "😀".repeat(160)));
  const result = room.search("kelvin", 50); const hit = result.results[0]; assert.ok(hit);
  assert.ok(Array.from(hit.snippet).length <= LIMITS.searchSnippetCodePoints);
  assert.equal(hit.snippet.slice(hit.matches[0]?.start, hit.matches[0]?.end), "Kelvin");
  assert.equal(parseSearchResponse(result).ok, true);
  assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(hit.snippet));
});

test("search ignores author names and quote snapshots and supports long literal needles", () => {
  const room = new Room(); const alice = user("author-only"); const first = room.send(alice, sendInput("original phrase"));
  room.send(user("Bob"), { ...sendInput("reply content"), replyToId: first.receipt.messageId });
  assert.equal(room.search("author-only", 50).totalMatches, 0); assert.equal(room.search("original phrase", 50).totalMatches, 1);
  const needle = "A".repeat(LIMITS.searchQueryCodePoints); room.send(alice, sendInput("😀".repeat(100) + needle + "😀".repeat(100)));
  const hit = room.search(needle, 50).results[0]; assert.ok(hit); assert.equal(hit.matches.length, 1);
  assert.equal(hit.snippet.slice(hit.matches[0]?.start, hit.matches[0]?.end), needle);
});

test("domain guards reject invalid bodies and leave room state unchanged", () => {
  const room = new Room(); const alice = user();
  expectCode(() => room.send(alice, sendInput(" \n\t ")), "CONTENT_EMPTY");
  expectCode(() => room.send(alice, sendInput("😀".repeat(LIMITS.messageBodyUtf8Bytes / 4 + 1))), "CONTENT_TOO_LARGE");
  expectCode(() => room.send(alice, sendInput("x\0y")), "BAD_REQUEST");
  expectCode(() => room.react(alice, reactionInput(randomUUID())), "MESSAGE_NOT_FOUND");
  expectCode(() => room.search(" ", 50), "BAD_REQUEST");
  assert.equal(room.revision, 0); assert.equal(room.messages.length, 0);
});

test("snapshots and delta events satisfy the shared runtime guards", () => {
  const room = new Room(); const alice = user(); const result = room.send(alice, sendInput());
  assert.equal(parseServerEvent({ v: 1, type: "room.delta", epochId: room.epochId, serverTime: Date.now(), payload: result.delta }).ok, true);
  assert.equal(parseServerEvent({ v: 1, type: "room.snapshot", epochId: room.epochId, serverTime: Date.now(), requestId: randomUUID(), payload: { snapshot: snapshot(room) } }).ok, true);
});

test("property ordering does not change the logical-operation fingerprint", () => {
  const room = new Room(); const alice = user(); const input = sendInput("same"); room.send(alice, input);
  const duplicate: SendMessageInput = { replyToId: null, content: { text: "same", kind: "text" }, roomId: "lobby", operationId: input.operationId };
  assert.equal(room.send(alice, duplicate).receipt.duplicate, true);
});

test("reaction growth enforces the same serialized window budget atomically", () => {
  const room = new Room(); const alice = user();
  for (let i = 0; i < 64; i += 1) room.send(alice, sendInput("x".repeat(LIMITS.messageBodyUtf8Bytes)));
  const remaining = LIMITS.historyJsonUtf8Bytes - room.history().serializedBytes;
  assert.ok(remaining > 1000);
  const messageId = room.send(alice, sendInput("x".repeat(remaining - 600))).receipt.messageId;
  let evicted = false;
  for (let i = 0; i < LIMITS.reactionUsersPerEmoji; i += 1) {
    const result = room.react(user(String(i)), reactionInput(messageId));
    if ((result.delta?.evictedMessageIds.length ?? 0) > 0) {
      evicted = true;
      assert.equal(result.delta?.history.serializedBytes, room.history().serializedBytes);
    }
    assert.ok(room.history().serializedBytes <= LIMITS.historyJsonUtf8Bytes);
  }
  assert.equal(evicted, true);
  assert.deepEqual(snapshotInvariantErrors(snapshot(room)), []);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { advanceDraft, applyRoomDelta, composerDisabledReason, reconcileOutbox } from "../client/src/app/model.js";
import { emptyDraft } from "../client/src/services/storage.js";
import type { ChatMessage, HistoryWindow, RoomDelta, RoomSnapshot } from "../shared/domain.js";
import type { OutboxEntry } from "../shared/persistence.js";
import { LIMITS } from "../shared/limits.js";
import { utf8Bytes } from "../shared/validation.js";

const epoch = randomUUID();
const author = { id: randomUUID(), displayName: "Alice", avatarSeed: "alice" };
const visitor = { id: randomUUID(), displayName: "Bob", avatarSeed: "bob" };

function message(sequence: number, body = "Hello"): ChatMessage {
  return { id: randomUUID(), roomId: "lobby", epochId: epoch, clientOperationId: randomUUID(), author, sequence,
    createdAt: sequence * 1000, content: { kind: "text", text: body }, reply: null, reactions: [], mutationRevision: sequence };
}
function history(messages: readonly ChatMessage[]): HistoryWindow {
  return { retainedCount: messages.length, limit: LIMITS.historyMessages, serializedBytes: utf8Bytes(JSON.stringify(messages)),
    maxSerializedBytes: LIMITS.historyJsonUtf8Bytes, oldestSequence: messages[0]?.sequence ?? null,
    newestSequence: messages.at(-1)?.sequence ?? null, persistence: "memory-until-server-restart" };
}
function snapshot(messages: readonly ChatMessage[] = []): RoomSnapshot {
  return { roomId: "lobby", epochId: epoch, revision: messages.at(-1)?.mutationRevision ?? 0, capturedAt: 1000,
    messages, history: history(messages), presence: { version: 0, members: [author, visitor] }, typing: { version: 0, entries: [] } };
}
function createDelta(base: RoomSnapshot, incoming: ChatMessage, evictedMessageIds: readonly string[] = []): RoomDelta {
  const retained = [...base.messages, incoming].filter(item => !evictedMessageIds.includes(item.id));
  return { roomId: "lobby", revision: base.revision + 1, change: { kind: "message.created", message: incoming }, evictedMessageIds, history: history(retained) };
}

test("draft changes preserve independent buffers and monotonically advance revision", () => {
  const initial = { ...emptyDraft(), textBuffer: "Text buffer", codeBuffer: { source: "\tcode\n", language: "typescript" as const } };
  const codeMode = advanceDraft(initial, { type: "mode.changed", value: "code" });
  const codeEdit = advanceDraft(codeMode, { type: "code.changed", value: "\treturn 1;\n" });
  const textMode = advanceDraft(codeEdit, { type: "mode.changed", value: "text" });
  assert.equal(textMode.textBuffer, initial.textBuffer);
  assert.equal(textMode.codeBuffer.source, "\treturn 1;\n");
  assert.equal(textMode.codeBuffer.language, "typescript");
  assert.equal(textMode.revision, initial.revision + 3);
  assert.equal(initial.codeBuffer.source, "\tcode\n");
});

test("outbox reconciliation scopes operation identity by author and leaves draft data untouched", () => {
  const operationId = randomUUID();
  const entry: OutboxEntry = { operationId, epochId: epoch, ownerUserId: author.id, localCreatedAt: 0,
    input: { operationId, roomId: "lobby", content: { kind: "text", text: "A" }, replyToId: null }, delivery: { phase: "sending" } };
  const otherAuthor = { ...message(1), author: visitor, clientOperationId: operationId };
  assert.deepEqual(reconcileOutbox([entry], [otherAuthor]), [entry]);
  assert.deepEqual(reconcileOutbox([entry], [{ ...otherAuthor, author }]), []);
});

test("duplicate and missing room revisions cannot mutate the current snapshot", () => {
  const base = snapshot([message(1)]), before = JSON.stringify(base);
  const delta = createDelta(base, message(2));
  assert.equal(applyRoomDelta(base, { ...delta, revision: 1 }).kind, "duplicate");
  assert.equal(applyRoomDelta(base, { ...delta, revision: 3 }).kind, "gap");
  assert.equal(JSON.stringify(base), before);
});

test("new messages and history eviction apply atomically", () => {
  const old = message(1), retained = message(2), incoming = message(3);
  const base = snapshot([old, retained]);
  const result = applyRoomDelta(base, createDelta(base, incoming, [old.id]));
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.snapshot.messages.map(item => item.id), [retained.id, incoming.id]);
  assert.equal(result.snapshot.revision, 3);
  assert.deepEqual(base.messages.map(item => item.id), [old.id, retained.id]);
});

test("cross-epoch messages and inconsistent history sizes require synchronization", () => {
  const base = snapshot([message(1)]);
  const incoming = message(2);
  const delta = createDelta(base, incoming);
  assert.equal(applyRoomDelta(base, { ...delta, change: { kind: "message.created", message: { ...incoming, epochId: randomUUID() } } }).kind, "gap");
  assert.equal(applyRoomDelta(base, { ...delta, history: { ...delta.history, serializedBytes: delta.history.serializedBytes + 1 } }).kind, "gap");
});

test("message mutation revisions cannot exceed the applied room revision", () => {
  const base = snapshot([message(1)]);
  const incoming = { ...message(2), mutationRevision: 100 };
  assert.equal(applyRoomDelta(base, createDelta(base, incoming)).kind, "gap");
});

test("composer uses byte limits and connection/outbox constraints for text and code", () => {
  const initial = emptyDraft();
  const ready = { phase: "ready" as const };
  assert.equal(composerDisabledReason({ ...initial, textBuffer: "😀".repeat(4096) }, ready, 0), null);
  assert.equal(composerDisabledReason({ ...initial, textBuffer: "😀".repeat(4097) }, ready, 0), "too-large");
  const draft = { ...initial, mode: "code" as const, codeBuffer: { source: "code", language: "typescript" as const } };
  assert.equal(composerDisabledReason(draft, ready, LIMITS.pendingMessages), "outbox-full");
  assert.equal(composerDisabledReason(draft, { phase: "offline", canRetry: true }, 0), "offline");
  assert.equal(composerDisabledReason(draft, { phase: "synchronizing" }, 0), "synchronizing");
});

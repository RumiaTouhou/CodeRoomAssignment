import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { applyRoomDelta } from "../client/src/app/model.js";
import type { ChatMessage, HistoryWindow, RoomSnapshot } from "../shared/domain.js";
import { LIMITS } from "../shared/limits.js";
import { utf8Bytes } from "../shared/validation.js";

const epochId = randomUUID();
const author = { id: randomUUID(), displayName: "Ada", avatarSeed: "ada" };
const message: ChatMessage = { id: randomUUID(), roomId: "lobby", epochId, clientOperationId: randomUUID(), author,
  sequence: 1, createdAt: 1_000, content: { kind: "code", language: "typescript", source: "\tconst ready = true;\n" }, reply: null, reactions: [], mutationRevision: 1 };
const history = (messages: readonly ChatMessage[]): HistoryWindow => ({ retainedCount: messages.length, limit: LIMITS.historyMessages,
  serializedBytes: utf8Bytes(JSON.stringify(messages)), maxSerializedBytes: LIMITS.historyJsonUtf8Bytes,
  oldestSequence: messages[0]?.sequence ?? null, newestSequence: messages.at(-1)?.sequence ?? null, persistence: "sqlite" });
const snapshot = (): RoomSnapshot => ({ roomId: "lobby", epochId, revision: 1, capturedAt: 1_000, messages: [message], history: history([message]),
  presence: { version: 1, members: [author] }, typing: { version: 0, entries: [] }, pin: null });

test("pin changes advance the room revision without mutating retained messages", () => {
  const initial = snapshot();
  const pin = { message, pinnedAt: 2_000, pinnedBy: author };
  const result = applyRoomDelta(initial, { roomId: "lobby", revision: 2, change: { kind: "pin.changed", pin }, evictedMessageIds: [], history: initial.history });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.snapshot.revision, 2);
  assert.equal(result.snapshot.pin, pin);
  assert.deepEqual(result.snapshot.messages, [message]);
  assert.equal(message.mutationRevision, 1);
  assert.equal(initial.pin, null);
});

test("a pin snapshot survives source eviction and can be cleared with a later delta", () => {
  const initial = { ...snapshot(), pin: { message, pinnedAt: 2_000, pinnedBy: author } };
  const incoming = { ...message, id: randomUUID(), clientOperationId: randomUUID(), sequence: 2, mutationRevision: 2 };
  const retained = [incoming];
  const applied = applyRoomDelta(initial, { roomId: "lobby", revision: 2, change: { kind: "message.created", message: incoming }, evictedMessageIds: [message.id], history: history(retained) });
  assert.equal(applied.kind, "applied");
  if (applied.kind !== "applied") return;
  assert.deepEqual(applied.snapshot.pin?.message.content, message.content);
  assert.equal(applied.snapshot.messages.some(item => item.id === message.id), false);
  const cleared = applyRoomDelta(applied.snapshot, { roomId: "lobby", revision: 3, change: { kind: "pin.changed", pin: null }, evictedMessageIds: [], history: history(retained) });
  assert.equal(cleared.kind, "applied");
  if (cleared.kind === "applied") assert.equal(cleared.snapshot.pin, null);
});

test("pins from another room epoch require synchronization", () => {
  const initial = snapshot();
  const result = applyRoomDelta(initial, { roomId: "lobby", revision: 2,
    change: { kind: "pin.changed", pin: { message: { ...message, epochId: randomUUID() }, pinnedAt: 2_000, pinnedBy: author } }, evictedMessageIds: [], history: initial.history });
  assert.equal(result.kind, "gap");
  assert.equal(initial.pin, null);
});

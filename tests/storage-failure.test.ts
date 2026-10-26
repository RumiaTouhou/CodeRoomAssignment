import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PublicUser, SendMessageInput, SetPinInput, SetReactionInput } from "../shared/domain.js";
import { Database, StorageError } from "../server/database.js";
import { Room, RoomError, type RoomState } from "../server/room.js";

const user = (): PublicUser => ({ id: randomUUID(), displayName: "River", avatarSeed: "aabbccddeeff0011" });
const messageInput = (): SendMessageInput => ({ operationId: randomUUID(), roomId: "lobby", content: { kind: "text", text: "Durable conversation" }, replyToId: null });
const storageFailure = (error: unknown): boolean => error instanceof RoomError && error.problem.code === "STORAGE_UNAVAILABLE" && error.problem.outcome === "not-applied";

test("a serialization failure rolls back the database transaction and leaves the connection usable", () => {
  const database = new Database();
  try {
    database.write("room", { revision: 3 });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.throws(() => database.write("room", circular), StorageError);
    assert.deepEqual(database.read("room"), { revision: 3 });
    database.write("room", { revision: 4 });
    assert.deepEqual(database.read("room"), { revision: 4 });
  } finally { database.close(); }
});

test("an unsupported database schema is rejected without rewriting its version", () => {
  const directory = mkdtempSync(join(tmpdir(), "coderoom-schema-"));
  const path = join(directory, "room.sqlite");
  try {
    const source = new DatabaseSync(path);
    source.exec("PRAGMA user_version = 2; CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('preserved');");
    source.close();
    assert.throws(() => new Database(path), /schema is newer/);
    const inspect = new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 2);
      assert.equal(inspect.prepare("SELECT value FROM retained").get()?.value, "preserved");
    } finally { inspect.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a file that is not a database is rejected without replacing its contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "coderoom-storage-"));
  const path = join(directory, "room.sqlite");
  const bytes = Buffer.from("Conversation storage cannot be replaced silently.");
  try {
    writeFileSync(path, bytes);
    assert.throws(() => new Database(path));
    assert.deepEqual(readFileSync(path), bytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("coupled session and receipt writes roll back together when a later statement fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "coderoom-transaction-"));
  const path = join(directory, "room.sqlite");
  const database = new Database(path);
  try {
    database.writeMany([["room", { receipts: 1 }], ["sessions", { active: 1 }]]);
    const control = new DatabaseSync(path);
    try {
      control.exec("CREATE TRIGGER reject_session_write BEFORE UPDATE ON application_state WHEN old.name = 'sessions' BEGIN SELECT RAISE(ABORT, 'Storage write rejected'); END;");
    } finally { control.close(); }
    assert.throws(() => database.writeMany([["room", { receipts: 0 }], ["sessions", { active: 0 }]]), StorageError);
    assert.deepEqual(database.read("room"), { receipts: 1 });
    assert.deepEqual(database.read("sessions"), { active: 1 });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed durable send leaves no message, sequence change or operation receipt", () => {
  const author = user();
  let fail = true;
  let persisted: RoomState | undefined;
  const room = new Room({ persistent: true, persist: state => {
    if (fail) throw new StorageError();
    persisted = structuredClone(state);
  } });
  const input = messageInput();
  const before = structuredClone(room.exportState());
  assert.throws(() => room.send(author, input), storageFailure);
  assert.deepEqual(room.exportState(), before);
  assert.equal(room.hasOperation(author.id, input.operationId), false);
  fail = false;
  const accepted = room.send(author, input);
  assert.equal(accepted.receipt.sequence, 1);
  assert.equal(accepted.receipt.duplicate, false);
  assert.ok(persisted);
  const restored = new Room({ state: persisted, persistent: true });
  const retry = restored.send(author, input);
  assert.equal(retry.receipt.duplicate, true);
  assert.equal(retry.receipt.messageId, accepted.receipt.messageId);
  assert.equal(restored.messages.length, 1);
});

test("failed reaction and pin persistence restore both public state and deduplication receipts", () => {
  const author = user();
  let fail = false;
  const room = new Room({ persistent: true, persist: () => { if (fail) throw new StorageError(); } });
  const accepted = room.send(author, messageInput());
  const reaction: SetReactionInput = { operationId: randomUUID(), roomId: "lobby", messageId: accepted.receipt.messageId, emoji: "✅", active: true };
  const pin: SetPinInput = { operationId: randomUUID(), roomId: "lobby", messageId: accepted.receipt.messageId };
  const before = structuredClone(room.exportState());
  fail = true;
  assert.throws(() => room.react(author, reaction), storageFailure);
  assert.deepEqual(room.exportState(), before);
  assert.equal(room.hasOperation(author.id, reaction.operationId), false);
  assert.throws(() => room.pin(author, pin, true), storageFailure);
  assert.deepEqual(room.exportState(), before);
  assert.equal(room.hasOperation(author.id, pin.operationId), false);
  fail = false;
  assert.equal(room.react(author, reaction).receipt.duplicate, false);
  assert.equal(room.pin(author, pin, true).receipt.duplicate, false);
  assert.equal(room.messages[0]?.reactions[0]?.userIds[0], author.id);
  assert.equal(room.exportState().pin?.message.id, accepted.receipt.messageId);
});

test("a write through a closed connection cannot be accepted by the room", () => {
  const database = new Database();
  const room = new Room({ persistent: true, persist: state => database.write("room", state) });
  database.close();
  assert.throws(() => room.send(user(), messageInput()), storageFailure);
  assert.equal(room.revision, 0);
  assert.equal(room.messages.length, 0);
});

test("a failed member record write is rolled back and can be retried", () => {
  const author = user();
  let fail = true;
  const room = new Room({ persistent: true, persist: () => { if (fail) throw new StorageError(); } });
  const event = { id: randomUUID(), kind: "left" as const, user: author, occurredAt: Date.now() };
  assert.throws(() => room.recordMemberEvent(event), storageFailure);
  assert.deepEqual(room.snapshot({ version: 0, members: [] }, { version: 0, entries: [] }).memberEvents, []);
  fail = false;
  room.recordMemberEvent(event);
  assert.deepEqual(room.snapshot({ version: 0, members: [] }, { version: 0, entries: [] }).memberEvents?.map(item => item.id), [event.id]);
});

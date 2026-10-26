import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createChatServer } from "../server/app.js";
import type { SessionCredential } from "../shared/http.js";
import type { RoomSnapshot } from "../shared/domain.js";
import type { ServerEvent } from "../shared/ws.js";
import { snapshotInvariantErrors } from "../shared/invariants.js";
import { parseServerJson } from "../shared/validation.js";
import { LIMITS } from "../shared/limits.js";

const browserOrigin = "https://collaboration.example";
type EventType = ServerEvent["type"];

class Participant {
  readonly socket: WebSocket;
  readonly events: ServerEvent[] = [];
  private readonly notifications = new EventEmitter();

  constructor(url: string, readonly credential: SessionCredential) {
    this.socket = new WebSocket(url, { origin: browserOrigin });
    this.socket.on("error", () => {});
    this.socket.on("message", data => {
      const parsed = parseServerJson(data.toString());
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.issue);
      this.events.push(parsed.value);
      this.notifications.emit("event");
    });
  }

  wait<T extends EventType>(type: T, matches: (event: Extract<ServerEvent, { type: T }>) => boolean = () => true): Promise<Extract<ServerEvent, { type: T }>> {
    const take = () => {
      const index = this.events.findIndex(event => event.type === type && matches(event as Extract<ServerEvent, { type: T }>));
      return index < 0 ? undefined : this.events.splice(index, 1)[0] as Extract<ServerEvent, { type: T }>;
    };
    const immediate = take();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.notifications.off("event", receive); reject(new Error(`Timed out waiting for ${type}`)); }, 4000);
      const receive = () => {
        const event = take();
        if (event) { clearTimeout(timeout); this.notifications.off("event", receive); resolve(event); }
      };
      this.notifications.on("event", receive);
    });
  }

  send(type: string, payload: unknown): string {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ v: 1, type, requestId, ...(type === "session.authenticate" ? {} : { epochId: this.credential.epochId }), payload }));
    return requestId;
  }

  async authenticate(): Promise<RoomSnapshot> {
    await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
    const requestId = this.send("session.authenticate", { token: this.credential.bearerToken });
    const ready = await this.wait("session.ready", event => event.requestId === requestId);
    assert.deepEqual(snapshotInvariantErrors(ready.payload.snapshot), []);
    assert.equal(ready.payload.self.id, this.credential.self.id);
    return ready.payload.snapshot;
  }

  async snapshot(): Promise<RoomSnapshot> {
    const requestId = this.send("room.sync", { roomId: "lobby" });
    const event = await this.wait("room.snapshot", response => response.requestId === requestId);
    assert.deepEqual(snapshotInvariantErrors(event.payload.snapshot), []);
    return event.payload.snapshot;
  }
}

test("eight concurrent guests converge on ordering, reactions and typing across disconnect and rejoin", async () => {
  const application = createChatServer({ staticDir: false, allowedOrigins: [browserOrigin],
    rateLimits: { session: 100, connection: 100, frame: 1000, message: 100, reaction: 100, typing: 100 } });
  const address = await application.listen();
  const participants: Participant[] = [];
  try {
    const credentials = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const response = await fetch(`${address.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", Origin: browserOrigin }, body: JSON.stringify({ displayName: `Participant ${index + 1}` }) });
      assert.equal(response.status, 201);
      return await response.json() as SessionCredential;
    }));
    for (const credential of credentials) participants.push(new Participant(address.webSocketUrl, credential));
    await Promise.all(participants.map(peer => peer.authenticate()));
    assert.equal(new Set(credentials.map(value => value.self.id)).size, 8);

    const operations = participants.flatMap((peer, index) => [0, 1].map(round => ({ peer, operationId: randomUUID(), text: `Participant ${index + 1}, round ${round + 1}: **literal** 😀` })));
    await Promise.all(operations.map(async operation => {
      const requestId = operation.peer.send("message.send", { operationId: operation.operationId, roomId: "lobby", content: { kind: "text", text: operation.text }, replyToId: null });
      const accepted = await operation.peer.wait("message.accepted", event => event.requestId === requestId);
      assert.equal(accepted.payload.operationId, operation.operationId);
      assert.equal(accepted.payload.duplicate, false);
    }));
    const initial = await participants[0]!.snapshot();
    assert.equal(initial.messages.length, 16);
    assert.deepEqual(initial.messages.map(message => message.sequence), Array.from({ length: 16 }, (_, index) => index + 1));
    assert.equal(new Set(initial.messages.map(message => message.id)).size, 16);
    assert.equal(new Set(initial.messages.map(message => message.clientOperationId)).size, 16);
    for (const operation of operations) {
      const message = initial.messages.find(value => value.clientOperationId === operation.operationId);
      assert.equal(message?.author.id, operation.peer.credential.self.id);
      assert.deepEqual(message?.content, { kind: "text", text: operation.text });
    }

    const messageId = initial.messages[0]!.id;
    await Promise.all(participants.map(async peer => {
      const requestId = peer.send("reaction.set", { operationId: randomUUID(), roomId: "lobby", messageId, emoji: "✅", active: true });
      const accepted = await peer.wait("reaction.accepted", event => event.requestId === requestId);
      assert.equal(accepted.payload.changed, true);
    }));
    const activeTypists = participants.slice(0, 4);
    await Promise.all(activeTypists.map(async peer => {
      peer.send("typing.set", { roomId: "lobby", active: true });
      await peer.wait("typing.state", event => event.payload.entries.some(entry => entry.userId === peer.credential.self.id));
    }));
    const typing = await participants[7]!.wait("typing.state", event => event.payload.entries.length === 4);
    assert.deepEqual(new Set(typing.payload.entries.map(entry => entry.userId)), new Set(activeTypists.map(peer => peer.credential.self.id)));
    await Promise.all(activeTypists.map(async peer => {
      peer.send("typing.set", { roomId: "lobby", active: false });
      await peer.wait("typing.state", event => !event.payload.entries.some(entry => entry.userId === peer.credential.self.id));
    }));

    const beforeDisconnect = await participants[0]!.snapshot();
    assert.deepEqual(new Set(beforeDisconnect.messages[0]!.reactions[0]!.userIds), new Set(credentials.map(value => value.self.id)));
    assert.equal(beforeDisconnect.typing.entries.length, 0);
    participants[6]!.socket.terminate(); participants[7]!.socket.terminate();
    const returned = new Participant(address.webSocketUrl, credentials[6]!); participants.push(returned);
    const reconnectSnapshot = await returned.authenticate();
    assert.deepEqual(reconnectSnapshot.messages, beforeDisconnect.messages);
    assert.equal(reconnectSnapshot.revision, beforeDisconnect.revision);
    const retried = operations.find(operation => operation.peer.credential.self.id === credentials[6]!.self.id)!;
    const requestId = returned.send("message.send", { operationId: retried.operationId, roomId: "lobby", content: { kind: "text", text: retried.text }, replyToId: null });
    const duplicate = await returned.wait("message.accepted", event => event.requestId === requestId);
    assert.equal(duplicate.payload.duplicate, true);

    const live = [...participants.slice(0, 6), returned];
    const snapshots = await Promise.all(live.map(peer => peer.snapshot()));
    for (const snapshot of snapshots) {
      assert.deepEqual(snapshot.messages, beforeDisconnect.messages);
      assert.equal(snapshot.revision, beforeDisconnect.revision);
      assert.equal(snapshot.history.serializedBytes, beforeDisconnect.history.serializedBytes);
      assert.equal(new Set(snapshot.presence.members.map(member => member.id)).size, snapshot.presence.members.length);
      assert.ok(snapshot.presence.members.some(member => member.id === returned.credential.self.id));
    }
    for (const peer of live) {
      const revisions = peer.events.flatMap(event => event.type === "room.delta" ? [event.payload.revision] : []);
      assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right));
      assert.equal(new Set(revisions).size, revisions.length);
    }
  } finally {
    for (const peer of participants) peer.socket.terminate();
    await application.close();
  }
});

test("SQLite restart preserves history, reactions, epoch and receipts while restore credentials cannot grant administrator access", async () => {
  const cache = resolve(".test-cache"); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "durable-collaboration-"));
  const dataFile = join(directory, "room.sqlite");
  const options = { dataFile, staticDir: false as const, allowedOrigins: [browserOrigin], adminPassword: "room-administration-secret",
    rateLimits: { session: 100, connection: 100, frame: 1000, message: 100, reaction: 100 } };
  let application: ReturnType<typeof createChatServer> | null = createChatServer(options);
  let address = await application.listen();
  const participants: Participant[] = [];
  const session = async (input: { displayName: string; adminPassword?: string; identityToken?: string }): Promise<SessionCredential> => {
    const response = await fetch(`${address.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", Origin: browserOrigin }, body: JSON.stringify(input) });
    assert.equal(response.status, 201);
    return await response.json() as SessionCredential;
  };
  const connect = async (credential: SessionCredential) => {
    const peer = new Participant(address.webSocketUrl, credential); participants.push(peer);
    await peer.authenticate(); return peer;
  };
  try {
    const administrator = await session({ displayName: "Alice", adminPassword: options.adminPassword });
    const guest = await session({ displayName: "Bob" });
    assert.equal(administrator.role, "admin"); assert.equal(guest.role, "guest");
    assert.match(administrator.identityToken ?? "", /^[0-9a-f]{64}$/);
    assert.match(guest.identityToken ?? "", /^[0-9a-f]{64}$/);
    const alice = await connect(administrator), bob = await connect(guest);
    const send = { operationId: randomUUID(), roomId: "lobby", content: { kind: "code", language: "typescript", source: '\tconst persisted = "**literal** 😀";\n' }, replyToId: null };
    const sendRequest = alice.send("message.send", send);
    const receipt = (await alice.wait("message.accepted", event => event.requestId === sendRequest)).payload;
    const reaction = { operationId: randomUUID(), roomId: "lobby", messageId: receipt.messageId, emoji: "✅", active: true };
    const reactionRequest = bob.send("reaction.set", reaction);
    await bob.wait("reaction.accepted", event => event.requestId === reactionRequest);
    const pin = { operationId: randomUUID(), roomId: "lobby", messageId: receipt.messageId };
    const pinRequest = alice.send("pin.set", pin);
    await alice.wait("pin.accepted", event => event.requestId === pinRequest);
    const before = await bob.snapshot();
    assert.equal(before.history.persistence, "sqlite");
    assert.equal(before.pin?.message.id, receipt.messageId);
    assert.deepEqual(before.messages[0]?.reactions[0]?.userIds, [guest.self.id]);
    await application.close(); application = null;
    const storedBytes = readFileSync(dataFile);
    for (const secret of [administrator.bearerToken, administrator.identityToken!, guest.bearerToken, guest.identityToken!, options.adminPassword]) {
      assert.equal(storedBytes.includes(Buffer.from(secret)), false, "SQLite must not persist plaintext authorization secrets");
    }

    application = createChatServer(options); address = await application.listen();
    const restoredGuest = await session({ displayName: "Bob", identityToken: guest.identityToken! });
    const restoredFormerAdmin = await session({ displayName: "Alice", identityToken: administrator.identityToken! });
    assert.equal(restoredGuest.self.id, guest.self.id);
    assert.equal(restoredFormerAdmin.self.id, administrator.self.id);
    assert.equal(restoredFormerAdmin.role, "guest");
    assert.equal(restoredGuest.epochId, before.epochId);
    const resumedBob = await connect(restoredGuest), unprivilegedAlice = await connect(restoredFormerAdmin);
    const restored = await resumedBob.snapshot();
    assert.deepEqual(restored.messages, before.messages);
    assert.deepEqual(restored.pin, before.pin);
    assert.equal(restored.revision, before.revision);
    const retryRequest = unprivilegedAlice.send("message.send", send);
    const duplicate = (await unprivilegedAlice.wait("message.accepted", event => event.requestId === retryRequest)).payload;
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.messageId, receipt.messageId);
    const reactionRetry = resumedBob.send("reaction.set", reaction);
    assert.equal((await resumedBob.wait("reaction.accepted", event => event.requestId === reactionRetry)).payload.duplicate, true);
    const deniedPin = unprivilegedAlice.send("pin.set", { operationId: randomUUID(), roomId: "lobby", messageId: null });
    assert.equal((await unprivilegedAlice.wait("request.error", event => event.payload.requestId === deniedPin)).payload.error.code, "FORBIDDEN");
    const forged = unprivilegedAlice.send("pin.set", { operationId: randomUUID(), roomId: "lobby", messageId: null, role: "admin" });
    assert.equal((await unprivilegedAlice.wait("request.error", event => event.payload.requestId === forged)).payload.error.code, "BAD_REQUEST");
    const wrongPassword = await fetch(`${address.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Alice", identityToken: administrator.identityToken, adminPassword: "wrong-password" }) });
    assert.equal(wrongPassword.status, 403); await wrongPassword.arrayBuffer();
    const confirmedAdmin = await session({ displayName: "Alice", identityToken: administrator.identityToken!, adminPassword: options.adminPassword });
    assert.equal(confirmedAdmin.role, "admin");
    const privilegedAlice = await connect(confirmedAdmin);
    const pinRetry = privilegedAlice.send("pin.set", pin);
    assert.equal((await privilegedAlice.wait("pin.accepted", event => event.requestId === pinRetry)).payload.duplicate, true);
    const after = await privilegedAlice.snapshot();
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.pin, before.pin);
    assert.equal(after.revision, before.revision);
    assert.equal(after.presence.members.filter(member => member.id === administrator.self.id).length, 1);
  } finally {
    for (const peer of participants) peer.socket.terminate();
    await application?.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("a public pin retains its complete source through history eviction and SQLite reopen", async () => {
  const cache = resolve(".test-cache"); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "pin-retention-"));
  const options = { dataFile: join(directory, "room.sqlite"), staticDir: false as const, allowedOrigins: [browserOrigin],
    rateLimits: { session: 100, connection: 100, frame: 1000, message: 100, reaction: 100 } };
  let application: ReturnType<typeof createChatServer> | null = createChatServer(options);
  let address = await application.listen();
  const participants: Participant[] = [];
  const session = async (identityToken?: string) => {
    const response = await fetch(`${address.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Alice", adminPassword: "114514", ...(identityToken ? { identityToken } : {}) }) });
    assert.equal(response.status, 201); return await response.json() as SessionCredential;
  };
  try {
    const owner = await session();
    const peer = new Participant(address.webSocketUrl, owner); participants.push(peer); await peer.authenticate();
    const source = '\tconst retainedPin = "<div>**literal** 😀</div>";\n'.repeat(14);
    const send = { operationId: randomUUID(), roomId: "lobby", content: { kind: "code", language: "typescript", source }, replyToId: null };
    const sendRequest = peer.send("message.send", send);
    const receipt = (await peer.wait("message.accepted", event => event.requestId === sendRequest)).payload;
    const pinRequest = peer.send("pin.set", { operationId: randomUUID(), roomId: "lobby", messageId: receipt.messageId });
    await peer.wait("pin.accepted", event => event.requestId === pinRequest);
    const pinned = (await peer.snapshot()).pin;
    assert.ok(pinned);
    for (let index = 0; index < 70; index++) {
      const requestId = peer.send("message.send", { operationId: randomUUID(), roomId: "lobby", content: { kind: "text", text: `${index}:` + "x".repeat(LIMITS.messageBodyUtf8Bytes - 20) }, replyToId: null });
      await peer.wait("message.accepted", event => event.requestId === requestId);
    }
    const evicted = await peer.snapshot();
    assert.equal(evicted.messages.some(message => message.id === receipt.messageId), false);
    assert.ok(evicted.history.retainedCount <= LIMITS.historyMessages);
    assert.ok(evicted.history.serializedBytes <= LIMITS.historyJsonUtf8Bytes);
    assert.deepEqual(evicted.pin, pinned);
    await application.close(); application = null;
    application = createChatServer(options); address = await application.listen();
    const restored = await session(owner.identityToken);
    const resumed = new Participant(address.webSocketUrl, restored); participants.push(resumed);
    const reopened = await resumed.authenticate();
    assert.equal(reopened.epochId, evicted.epochId);
    assert.deepEqual(reopened.messages, evicted.messages);
    assert.deepEqual(reopened.pin, pinned);
    const retry = resumed.send("message.send", send);
    const duplicate = (await resumed.wait("message.accepted", event => event.requestId === retry)).payload;
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.retained, false);
    assert.equal((await resumed.snapshot()).messages.length, evicted.messages.length);
  } finally {
    for (const peer of participants) peer.socket.terminate();
    await application?.close(); rmSync(directory, { recursive: true, force: true });
  }
});

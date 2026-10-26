import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createChatServer } from "../server/app.js";
import type { SessionCredential } from "../shared/http.js";
import type { ServerEvent } from "../shared/ws.js";
import { parseServerJson } from "../shared/validation.js";
import { snapshotInvariantErrors } from "../shared/invariants.js";

const origin = "http://localhost:5173";
type EventType = ServerEvent["type"];
class Peer {
  readonly socket: WebSocket;
  readonly events: ServerEvent[] = [];
  private readonly notifications = new EventEmitter();
  constructor(url: string) {
    this.socket = new WebSocket(url, { origin });
    this.socket.on("error", () => {});
    this.socket.on("message", data => {
      const parsed = parseServerJson(data.toString());
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.issue);
      this.events.push(parsed.value);
      this.notifications.emit("event");
    });
  }
  wait<T extends EventType>(type: T, accept: (event: Extract<ServerEvent, { type: T }>) => boolean = () => true): Promise<Extract<ServerEvent, { type: T }>> {
    const take = () => {
      const index = this.events.findIndex(event => event.type === type && accept(event as Extract<ServerEvent, { type: T }>));
      if (index < 0) return undefined;
      return this.events.splice(index, 1)[0] as Extract<ServerEvent, { type: T }>;
    };
    const immediate = take();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.notifications.off("event", receive); reject(new Error(`Timed out waiting for ${type}`)); }, 2000);
      const receive = () => { const event = take(); if (event) { clearTimeout(timeout); this.notifications.off("event", receive); resolve(event); } };
      this.notifications.on("event", receive);
    });
  }
  send(type: string, payload: unknown, epochId?: string): void {
    this.socket.send(JSON.stringify({ v: 1, type, requestId: randomUUID(), ...(epochId ? { epochId } : {}), payload }));
  }
}

let application: ReturnType<typeof createChatServer>;
let address: Awaited<ReturnType<typeof application.listen>>;
let peers: Peer[];
beforeEach(async () => {
  peers = [];
  application = createChatServer({ allowedOrigins: [origin], staticDir: false, typingTtlMs: 60,
    rateLimits: { session: 100, connection: 100, frame: 1000, message: 100, reaction: 100, typing: 100 } });
  address = await application.listen();
});
afterEach(async () => { for (const peer of peers) peer.socket.terminate(); await application.close(); });

async function guest(name: string): Promise<SessionCredential> {
  const response = await fetch(`${address.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ displayName: name }) });
  assert.equal(response.status, 201);
  return await response.json() as SessionCredential;
}
async function connect(credential: SessionCredential): Promise<Peer> {
  const peer = new Peer(address.webSocketUrl); peers.push(peer);
  await new Promise<void>((resolve, reject) => { peer.socket.once("open", resolve); peer.socket.once("error", reject); });
  peer.send("session.authenticate", { token: credential.bearerToken });
  const ready = await peer.wait("session.ready");
  assert.deepEqual(snapshotInvariantErrors(ready.payload.snapshot), []);
  assert.equal(ready.payload.self.id, credential.self.id);
  return peer;
}
const textInput = (text: string, operationId = randomUUID()) => ({ operationId, roomId: "lobby", content: { kind: "text", text }, replyToId: null });

test("two authenticated peers receive one authoritative transaction and a separate receipt", async () => {
  const alice = await guest("Alice"), bob = await guest("Bob");
  const a = await connect(alice), b = await connect(bob);
  await a.wait("presence.state", event => event.payload.members.length === 2);
  const input = textInput("  Hello **literal**\n"); a.send("message.send", input, alice.epochId);
  const [own, remote, ack] = await Promise.all([a.wait("room.delta"), b.wait("room.delta"), a.wait("message.accepted")]);
  assert.deepEqual(remote.payload, own.payload);
  assert.equal(own.payload.change.kind, "message.created");
  if (own.payload.change.kind !== "message.created") throw new Error("Expected message creation");
  assert.equal(own.payload.change.message.author.id, alice.self.id);
  assert.deepEqual(own.payload.change.message.content, input.content);
  assert.equal(ack.payload.messageId, own.payload.change.message.id);
  assert.equal(ack.payload.operationId, input.operationId);
});

test("concurrent reaction membership merges and an explicit no-op leaves the revision unchanged", async () => {
  const alice = await guest("Alice"), bob = await guest("Bob");
  const a = await connect(alice), b = await connect(bob);
  a.send("message.send", textInput("React here"), alice.epochId);
  const { payload: receipt } = await a.wait("message.accepted");
  const reaction = (operationId: string) => ({ operationId, roomId: "lobby", messageId: receipt.messageId, emoji: "✅", active: true });
  a.send("reaction.set", reaction(randomUUID()), alice.epochId);
  b.send("reaction.set", reaction(randomUUID()), bob.epochId);
  await Promise.all([a.wait("reaction.accepted"), b.wait("reaction.accepted")]);
  assert.deepEqual(new Set(application.room.messages[0]?.reactions[0]?.userIds), new Set([alice.self.id, bob.self.id]));
  const revision = application.room.revision;
  a.send("reaction.set", reaction(randomUUID()), alice.epochId);
  assert.equal((await a.wait("reaction.accepted")).payload.changed, false);
  assert.equal(application.room.revision, revision);
});

test("a replacement connection survives the old socket close and preserves distinct presence", async () => {
  const alice = await guest("Alice"), bob = await guest("Bob");
  const old = await connect(alice), b = await connect(bob);
  const closed = new Promise<number>(resolve => old.socket.once("close", code => resolve(code)));
  const current = await connect(alice);
  assert.equal((await old.wait("session.ended")).payload.reason, "replaced");
  assert.equal(await closed, 4409);
  current.send("room.sync", { roomId: "lobby" }, alice.epochId);
  assert.equal((await current.wait("room.snapshot")).payload.snapshot.presence.members.length, 2);
  current.send("message.send", textInput("The current window is still active"), alice.epochId);
  await current.wait("message.accepted");
  assert.equal((await b.wait("room.delta")).payload.change.kind, "message.created");
});

test("a retry after disconnect returns a duplicate receipt without a second message", async () => {
  const alice = await guest("Alice"); const a = await connect(alice);
  const input = textInput("One logical message"); a.send("message.send", input, alice.epochId);
  await a.wait("room.delta");
  a.socket.terminate();
  const reconnected = await connect(alice);
  reconnected.send("message.send", input, alice.epochId);
  const ack = await reconnected.wait("message.accepted");
  assert.equal(ack.payload.duplicate, true);
  assert.equal(application.room.messages.length, 1);
});

test("typing expires independently of room revision and a successful send clears it", async () => {
  const alice = await guest("Alice"), bob = await guest("Bob");
  const a = await connect(alice), b = await connect(bob);
  a.send("typing.set", { roomId: "lobby", active: true }, alice.epochId);
  const active = await b.wait("typing.state", event => event.payload.entries.length === 1);
  assert.equal(active.payload.entries[0]?.userId, alice.self.id);
  await b.wait("typing.state", event => event.payload.entries.length === 0);
  assert.equal(application.room.revision, 0);
  a.send("typing.set", { roomId: "lobby", active: true }, alice.epochId);
  await b.wait("typing.state", event => event.payload.entries.length === 1);
  a.send("message.send", textInput("Done typing"), alice.epochId);
  await b.wait("typing.state", event => event.payload.entries.length === 0);
  assert.equal(application.room.revision, 1);
});

test("epoch mismatch and sender spoofing cannot mutate room state", async () => {
  const alice = await guest("Alice"), a = await connect(alice);
  a.send("message.send", textInput("Wrong epoch"), randomUUID());
  assert.equal((await a.wait("request.error")).payload.error.code, "EPOCH_MISMATCH");
  a.send("message.send", { ...textInput("Fake author"), senderId: randomUUID() }, alice.epochId);
  assert.equal((await a.wait("request.error")).payload.error.code, "BAD_REQUEST");
  assert.equal(application.room.revision, 0);
  assert.equal(application.room.messages.length, 0);
});

test("a send operation cannot be reused as a reaction and oversized content is rejected", async () => {
  const alice = await guest("Alice"), a = await connect(alice);
  const input = textInput("Original"); a.send("message.send", input, alice.epochId);
  const ack = await a.wait("message.accepted");
  a.send("reaction.set", { operationId: input.operationId, roomId: "lobby", messageId: ack.payload.messageId, emoji: "👍", active: true }, alice.epochId);
  assert.equal((await a.wait("request.error")).payload.error.code, "OPERATION_ID_CONFLICT");
  a.send("message.send", textInput("😀".repeat(4097)), alice.epochId);
  assert.equal((await a.wait("request.error")).payload.error.code, "CONTENT_TOO_LARGE");
  assert.equal(application.room.messages.length, 1);
});

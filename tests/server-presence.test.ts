import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createChatServer, type ChatServerOptions } from "../server/app.js";
import type { CreateSessionRequest, SessionCredential } from "../shared/http.js";
import type { ServerEvent } from "../shared/ws.js";
import { parseServerJson } from "../shared/validation.js";
import { SessionStore } from "../server/sessions.js";
import { LIMITS } from "../shared/limits.js";

async function harness(options: ChatServerOptions = {}) {
  const application = createChatServer({ staticDir: false, presenceGraceMs: 80, rateLimits: { session: 100, connection: 100, frame: 1000 }, ...options });
  const address = await application.listen();
  const peers: WebSocket[] = [];
  async function join(input: CreateSessionRequest) {
    return fetch(`${address.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  }
  async function credential(input: CreateSessionRequest) {
    const response = await join(input);
    assert.equal(response.status, 201);
    return await response.json() as SessionCredential;
  }
  async function connect(session: SessionCredential) {
    const socket = new WebSocket(address.webSocketUrl, { origin: address.origin }); peers.push(socket);
    const events: ServerEvent[] = [];
    socket.on("error", () => {});
    socket.on("message", data => { const parsed = parseServerJson(data.toString()); assert.ok(parsed.ok); events.push(parsed.value); });
    await once(socket, "open");
    const send = (type: string, payload: unknown) => socket.send(JSON.stringify({ v: 1, type, requestId: randomUUID(), ...(type === "session.authenticate" ? {} : { epochId: session.epochId }), payload }));
    const wait = async <T extends ServerEvent["type"]>(type: T, predicate: (event: Extract<ServerEvent, { type: T }>) => boolean = () => true) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const event = events.find(candidate => candidate.type === type && predicate(candidate as Extract<ServerEvent, { type: T }>));
        if (event) return event as Extract<ServerEvent, { type: T }>;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`Missing ${type}`);
    };
    send("session.authenticate", { token: session.bearerToken }); await wait("session.ready");
    return { socket, events, send, wait };
  }
  return { application, address, join, credential, connect, async close() { for (const socket of peers) socket.terminate(); await application.close(); } };
}

const notices = (events: readonly ServerEvent[], userId: string) => events.filter(event => event.type === "member.event" && event.payload.user.id === userId).map(event => event.type === "member.event" ? event.payload.kind : "");

test("refresh within the disconnect grace preserves presence without replaying member events", async () => {
  const service = await harness();
  try {
    const watcher = await service.connect(await service.credential({ displayName: "Watcher" }));
    const guest = await service.credential({ displayName: "Guest" });
    const first = await service.connect(guest);
    await watcher.wait("member.event", event => event.payload.user.id === guest.self.id && event.payload.kind === "joined");
    assert.equal(first.events.find(event => event.type === "session.ready")?.type, "session.ready");
    const initialReady = first.events.find(event => event.type === "session.ready");
    assert.ok(initialReady?.type === "session.ready" && initialReady.payload.snapshot.memberEvents?.some(event => event.user.id === guest.self.id && event.kind === "joined"));
    first.socket.terminate(); await once(first.socket, "close");
    const resumed = await service.connect(guest);
    resumed.send("room.sync", { roomId: "lobby" });
    const snapshot = await resumed.wait("room.snapshot");
    assert.equal(snapshot.payload.snapshot.presence.members.length, 2);
    assert.deepEqual(notices(watcher.events, guest.self.id), ["joined"]);
    assert.deepEqual(notices(resumed.events, guest.self.id), []);
    resumed.socket.terminate();
    await watcher.wait("member.event", event => event.payload.user.id === guest.self.id && event.payload.kind === "left");
    const returned = await service.connect(guest);
    await watcher.wait("member.event", event => event.payload.user.id === guest.self.id && event.payload.kind === "returned");
    const returnedReady = returned.events.find(event => event.type === "session.ready");
    assert.ok(returnedReady?.type === "session.ready" && returnedReady.payload.snapshot.memberEvents?.some(event => event.user.id === guest.self.id && event.kind === "returned"));
    assert.deepEqual(notices(watcher.events, guest.self.id), ["joined", "left", "returned"]);
  } finally { await service.close(); }
});

test("explicit leave immediately announces departure and recovery reuses identity with a fresh guest session", async () => {
  const service = await harness({ presenceGraceMs: 10_000 });
  try {
    const watcher = await service.connect(await service.credential({ displayName: "Watcher" }));
    const guest = await service.credential({ displayName: "Guest", adminPassword: "114514" });
    await service.connect(guest);
    const leave = await fetch(`${service.address.origin}/api/session`, { method: "DELETE", headers: { Authorization: `Bearer ${guest.bearerToken}` } });
    assert.equal(leave.status, 204);
    await watcher.wait("member.event", event => event.payload.user.id === guest.self.id && event.payload.kind === "left");
    const recovered = await service.credential({ displayName: "Recovered Guest", identityToken: guest.identityToken! });
    assert.equal(recovered.self.id, guest.self.id);
    assert.equal(recovered.role, "guest");
    assert.notEqual(recovered.bearerToken, guest.bearerToken);
    await service.connect(recovered);
    const returned = await watcher.wait("member.event", event => event.payload.user.id === guest.self.id && event.payload.kind === "returned");
    assert.equal(returned.payload.user.displayName, "Recovered Guest");
    assert.equal(returned.payload.displayNameChanged, true);
  } finally { await service.close(); }
});

test("identity recovery revokes prior authority and cannot duplicate online membership", async () => {
  const service = await harness();
  try {
    const admin = await service.credential({ displayName: "Admin", adminPassword: "114514" });
    const previous = await service.connect(admin);
    const recovered = await service.credential({ displayName: "Guest", identityToken: admin.identityToken! });
    assert.equal(recovered.role, "guest");
    await previous.wait("session.ended");
    const current = await service.connect(recovered);
    const ready = await current.wait("session.ready");
    assert.equal(ready.payload.role, "guest");
    assert.equal(ready.payload.snapshot.presence.members.length, 1);
    current.send("pin.set", { operationId: randomUUID(), roomId: "lobby", messageId: null });
    assert.equal((await current.wait("request.error")).payload.error.code, "FORBIDDEN");
    const oldAccess = await fetch(`${service.address.origin}/api/rooms/lobby/search?q=test`, { headers: { Authorization: `Bearer ${admin.bearerToken}` } });
    assert.equal(oldAccess.status, 401);
    assert.equal((await service.join({ displayName: "Admin", adminPassword: "wrong" })).status, 403);
  } finally { await service.close(); }
});

test("expired recovery secrets reject and released sessions do not consume session capacity", () => {
  const store = new SessionStore(LIMITS.sessionTtlMs);
  const first = store.create({ displayName: "Guest" }, randomUUID(), 0, "guest");
  store.remove(first.session);
  assert.throws(() => store.create({ displayName: "Guest", identityToken: first.credential.identityToken! }, randomUUID(), LIMITS.identityTtlMs, "guest"));
  for (let index = 0; index < LIMITS.activeSessions + 5; index += 1) {
    const { session } = store.create({ displayName: "Guest" }, randomUUID(), index, "guest");
    store.remove(session);
  }
  assert.equal(store.size, 0);
});

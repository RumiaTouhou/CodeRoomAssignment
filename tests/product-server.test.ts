import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { createChatServer } from "../server/app.js";
import type { SessionCredential } from "../shared/http.js";
import type { ServerEvent } from "../shared/ws.js";

const allowedOrigin = "https://chat.example";

type RunningServer = ReturnType<typeof createChatServer>;

class EventInbox {
  private readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    socket.on("message", data => {
      this.events.push(JSON.parse(data.toString()) as ServerEvent);
      for (const listener of [...this.listeners]) listener();
    });
  }
  wait<T extends ServerEvent["type"]>(type: T): Promise<Extract<ServerEvent, { type: T }>> {
    const match = () => this.events.find(event => event.type === type) as Extract<ServerEvent, { type: T }> | undefined;
    const existing = match();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`Missing event: ${type}`)); }, 3000);
      const check = () => {
        const event = match();
        if (!event) return;
        clearTimeout(timer); this.listeners.delete(check); resolve(event);
      };
      this.listeners.add(check);
    });
  }
}

async function start(options: Parameters<typeof createChatServer>[0] = {}) {
  const app = createChatServer({ staticDir: false, allowedOrigins: [allowedOrigin], ...options });
  const address = await app.listen();
  return { app, ...address };
}

async function session(origin: string, displayName = "Alice"): Promise<SessionCredential> {
  const response = await fetch(`${origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", Origin: allowedOrigin }, body: JSON.stringify({ displayName }) });
  assert.equal(response.status, 201);
  return await response.json() as SessionCredential;
}

async function connect(webSocketUrl: string, credential: SessionCredential, socketOptions: { autoPong?: boolean } = {}) {
  const socket = new WebSocket(webSocketUrl, { origin: allowedOrigin, ...socketOptions });
  socket.on("error", () => {});
  const inbox = new EventInbox(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ v: 1, type: "session.authenticate", requestId: randomUUID(), payload: { token: credential.bearerToken } }));
  const ready = await inbox.wait("session.ready");
  return { socket, inbox, ready };
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket did not close")), 3000);
    socket.once("close", code => { clearTimeout(timer); resolve(code); });
  });
}

async function dispose(app: RunningServer, sockets: WebSocket[] = []) {
  for (const socket of sockets) socket.terminate();
  await app.close();
}

test("HTTP CORS policy accepts configured origins and refuses untrusted origins", async () => {
  const server = await start();
  try {
    const accepted = await fetch(`${server.origin}/api/health`, { headers: { Origin: allowedOrigin } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.notEqual(accepted.headers.get("access-control-allow-credentials"), "true");
    const preflight = await fetch(`${server.origin}/api/sessions`, { method: "OPTIONS", headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type, Authorization" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/i);
    const denied = await fetch(`${server.origin}/api/health`, { headers: { Origin: "https://untrusted.example" } });
    assert.equal(denied.status, 403);
    assert.notEqual(denied.headers.get("access-control-allow-origin"), "https://untrusted.example");
  } finally { await dispose(server.app); }
});

test("HTTP session validation and search authentication preserve the data boundary", async () => {
  const server = await start();
  try {
    const unauthorized = await fetch(`${server.origin}/api/rooms/lobby/search?q=test`);
    assert.equal(unauthorized.status, 401);
    const malformed = await fetch(`${server.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"displayName":"Alice","senderId":"forged"}' });
    assert.equal(malformed.status, 400);
    const oversized = await fetch(`${server.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "A".repeat(100000) }) });
    assert.ok([400, 413].includes(oversized.status));
    const credential = await session(server.origin);
    const search = await fetch(`${server.origin}/api/rooms/lobby/search?q=literal`, { headers: { Authorization: `Bearer ${credential.bearerToken}` } });
    assert.equal(search.status, 200);
    assert.match(search.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(!(await search.text()).includes(credential.bearerToken));
  } finally { await dispose(server.app); }
});

test("WebSocket upgrade rejects unknown and absent browser origins", async () => {
  const server = await start();
  try {
    for (const origin of [undefined, "https://untrusted.example"]) {
      const socket = new WebSocket(server.webSocketUrl, origin ? { origin } : {});
      socket.on("error", () => {});
      const status = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new Error("Upgrade did not reject")); }, 3000);
        socket.once("unexpected-response", (_request, response) => { clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
        socket.once("open", () => { clearTimeout(timer); socket.terminate(); reject(new Error("Untrusted origin accepted")); });
      });
      assert.equal(status, 403);
    }
  } finally { await dispose(server.app); }
});

test("an unauthenticated socket expires without becoming an online member", async () => {
  const server = await start({ authenticationTimeoutMs: 40 });
  const socket = new WebSocket(server.webSocketUrl, { origin: allowedOrigin });
  socket.on("error", () => {});
  try {
    const code = await closed(socket);
    assert.equal(code, 4401);
    const credential = await session(server.origin);
    const live = await connect(server.webSocketUrl, credential);
    assert.deepEqual(live.ready.payload.snapshot.presence.members.map(member => member.id), [credential.self.id]);
    live.socket.terminate();
  } finally { await dispose(server.app, [socket]); }
});

test("revoking a session closes its active connection and invalidates HTTP access", async () => {
  const server = await start();
  const sockets: WebSocket[] = [];
  try {
    const credential = await session(server.origin);
    const client = await connect(server.webSocketUrl, credential); sockets.push(client.socket);
    const closure = closed(client.socket);
    const response = await fetch(`${server.origin}/api/session`, { method: "DELETE", headers: { Authorization: `Bearer ${credential.bearerToken}` } });
    assert.equal(response.status, 204);
    assert.equal((await client.inbox.wait("session.ended")).payload.reason, "revoked");
    await closure;
    const search = await fetch(`${server.origin}/api/rooms/lobby/search?q=text`, { headers: { Authorization: `Bearer ${credential.bearerToken}` } });
    assert.equal(search.status, 401);
  } finally { await dispose(server.app, sockets); }
});

test("session creation rate limits return a retryable response without leaking credentials", async () => {
  const server = await start({ rateLimits: { session: 1 } });
  try {
    const credential = await session(server.origin);
    const response = await fetch(`${server.origin}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Bob" }) });
    assert.equal(response.status, 429);
    const body = await response.json() as { error: { retryable: boolean; retryAfterMs?: number } };
    assert.equal(body.error.retryable, true);
    assert.ok((body.error.retryAfterMs ?? 0) > 0);
    assert.ok(!JSON.stringify(body).includes(credential.bearerToken));
  } finally { await dispose(server.app); }
});

test("static assets cannot expose files outside the configured public directory", async () => {
  const parent = join(process.cwd(), ".test-cache");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "static-"));
  const publicDirectory = join(directory, "public");
  await mkdir(publicDirectory);
  await writeFile(join(publicDirectory, "index.html"), "<!doctype html><title>CodeRoom</title>");
  const privateText = randomUUID();
  await writeFile(join(directory, "private.txt"), privateText);
  const server = await start({ staticDir: publicDirectory });
  try {
    const index = await fetch(server.origin);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /CodeRoom/);
    for (const path of ["/%2e%2e%2fprivate.txt", "/..%5cprivate.txt", "/%00private.txt"]) {
      const response = await fetch(server.origin + path);
      assert.ok(!(await response.text()).includes(privateText));
    }
  } finally { await dispose(server.app); await rm(directory, { recursive: true, force: true }); }
});


test("invalid and binary frames cannot create authoritative room messages", async () => {
  const server = await start();
  const sockets: WebSocket[] = [];
  try {
    const credential = await session(server.origin);
    const client = await connect(server.webSocketUrl, credential); sockets.push(client.socket);
    client.socket.send(JSON.stringify({ v: 1, type: "message.send", requestId: randomUUID(), epochId: credential.epochId,
      payload: { operationId: randomUUID(), roomId: "lobby", content: { kind: "text", text: "Forged author" }, replyToId: null, senderId: randomUUID() } }));
    assert.equal((await client.inbox.wait("request.error")).payload.error.code, "BAD_REQUEST");
    assert.equal(server.app.room.messages.length, 0);
    const closure = closed(client.socket);
    client.socket.send(Buffer.from("{}"));
    assert.equal(await closure, 1007);
    assert.equal(server.app.room.messages.length, 0);
    assert.equal((await fetch(`${server.origin}/api/health`)).status, 200);
  } finally { await dispose(server.app, sockets); }
});

test("expired credentials close the active session and cannot search", async () => {
  let now = 100000;
  const server = await start({ clock: () => now, sessionTtlMs: 100 });
  const sockets: WebSocket[] = [];
  try {
    const credential = await session(server.origin);
    const client = await connect(server.webSocketUrl, credential); sockets.push(client.socket);
    const closure = closed(client.socket);
    now += 101;
    const response = await fetch(`${server.origin}/api/rooms/lobby/search?q=text`, { headers: { Authorization: `Bearer ${credential.bearerToken}` } });
    assert.equal(response.status, 401);
    assert.equal((await client.inbox.wait("session.ended")).payload.reason, "expired");
    assert.equal(await closure, 4410);
  } finally { await dispose(server.app, sockets); }
});

test("heartbeat removes sockets that stop answering protocol pings", async () => {
  const server = await start({ heartbeatIntervalMs: 20, heartbeatGraceMs: 20 });
  const sockets: WebSocket[] = [];
  try {
    const credential = await session(server.origin);
    const client = await connect(server.webSocketUrl, credential, { autoPong: false }); sockets.push(client.socket);
    let pings = 0; client.socket.on("ping", () => pings++);
    assert.equal(await closed(client.socket), 1006);
    assert.ok(pings > 0);
  } finally { await dispose(server.app, sockets); }
});

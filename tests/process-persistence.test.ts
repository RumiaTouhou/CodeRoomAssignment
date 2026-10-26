import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";
import type { SessionCredential } from "../shared/http.js";
import type { ServerEvent } from "../shared/ws.js";
import { parseServerJson } from "../shared/validation.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://localhost:5173";

class ServerProcess {
  readonly process: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly port: Promise<number>;

  constructor(dataFile: string) {
    this.process = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: root,
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_FILE: dataFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.exit = new Promise(resolve => this.process.once("exit", (code, signal) => resolve({ code, signal })));
    this.port = new Promise((resolve, reject) => {
      let output = "";
      let errors = "";
      const timer = setTimeout(() => reject(new Error("The application process did not start.")), 5000);
      this.process.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
        const match = /CodeRoom listening on port (\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      this.process.stderr?.on("data", (data: Buffer) => { errors += data.toString(); });
      this.process.once("error", error => { clearTimeout(timer); reject(error); });
      this.process.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`The application exited during startup (${code}): ${errors}`));
      });
    });
  }

  async stop(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill(signal);
    return this.exit;
  }
}

class Client {
  readonly socket: WebSocket;
  private readonly events: ServerEvent[] = [];
  private readonly notifications = new EventEmitter();

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    this.socket.on("error", () => {});
    this.socket.on("message", data => {
      const parsed = parseServerJson(data.toString());
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.issue);
      this.events.push(parsed.value);
      this.notifications.emit("message");
    });
  }

  send(type: string, payload: unknown, epochId?: string): void {
    this.socket.send(JSON.stringify({ v: 1, type, requestId: randomUUID(), ...(epochId ? { epochId } : {}), payload }));
  }

  wait<T extends ServerEvent["type"]>(type: T): Promise<Extract<ServerEvent, { type: T }>> {
    const take = () => {
      const index = this.events.findIndex(event => event.type === type);
      return index < 0 ? undefined : this.events.splice(index, 1)[0] as Extract<ServerEvent, { type: T }>;
    };
    const immediate = take();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.notifications.off("message", receive); reject(new Error(`Missing event: ${type}`)); }, 3000);
      const receive = () => {
        const event = take();
        if (event) { clearTimeout(timer); this.notifications.off("message", receive); resolve(event); }
      };
      this.notifications.on("message", receive);
    });
  }

  async authenticate(credential: SessionCredential): Promise<Extract<ServerEvent, { type: "session.ready" }>> {
    await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
    this.send("session.authenticate", { token: credential.bearerToken });
    return this.wait("session.ready");
  }
}

test("accepted messages, reactions, pins and receipts survive process restarts and abrupt stops", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "coderoom-process-"));
  const processes: ServerProcess[] = [];
  const clients: Client[] = [];
  const launch = async () => {
    const server = new ServerProcess(join(directory, "conversation.sqlite"));
    processes.push(server);
    return { server, port: await server.port };
  };
  const connect = async (port: number, credential: SessionCredential) => {
    const client = new Client(port); clients.push(client);
    return { client, ready: await client.authenticate(credential) };
  };
  try {
    const first = await launch();
    const response = await fetch(`http://127.0.0.1:${first.port}/api/sessions`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "River", adminPassword: "114514" }),
    });
    assert.equal(response.status, 201);
    const credential = await response.json() as SessionCredential;
    const a = await connect(first.port, credential);
    const input = { operationId: randomUUID(), roomId: "lobby", content: { kind: "code", language: "javascript", source: "\tconst text = '**Here** I am';\n" }, replyToId: null };
    a.client.send("message.send", input, credential.epochId);
    const receipt = (await a.client.wait("message.accepted")).payload;
    a.client.send("reaction.set", { operationId: randomUUID(), roomId: "lobby", messageId: receipt.messageId, emoji: "✅", active: true }, credential.epochId);
    await a.client.wait("reaction.accepted");
    a.client.send("pin.set", { operationId: randomUUID(), roomId: "lobby", messageId: receipt.messageId }, credential.epochId);
    await a.client.wait("pin.accepted");
    const stopped = await first.server.stop("SIGINT");
    if (process.platform !== "win32") assert.equal(stopped.code, 0);

    const second = await launch();
    const b = await connect(second.port, credential);
    assert.equal(b.ready.epochId, credential.epochId);
    const snapshot = b.ready.payload.snapshot;
    assert.equal(snapshot.history.persistence, "sqlite");
    assert.deepEqual(snapshot.messages[0]?.content, input.content);
    assert.equal(snapshot.messages[0]?.reactions[0]?.userIds[0], credential.self.id);
    assert.equal(snapshot.pin?.message.id, receipt.messageId);
    assert.ok(snapshot.memberEvents?.some(event => event.user.id === credential.self.id && event.kind === "joined"));
    b.client.send("message.send", input, credential.epochId);
    assert.equal((await b.client.wait("message.accepted")).payload.duplicate, true);
    const continuation = { operationId: randomUUID(), roomId: "lobby", content: { kind: "text", text: "Conversation continues after restart." }, replyToId: receipt.messageId };
    b.client.send("message.send", continuation, credential.epochId);
    const continued = (await b.client.wait("message.accepted")).payload;
    assert.equal(continued.sequence, 2);
    await second.server.stop("SIGKILL");

    const third = await launch();
    const c = await connect(third.port, credential);
    assert.equal(c.ready.payload.snapshot.messages.length, 2);
    assert.equal(c.ready.payload.snapshot.messages[1]?.reply?.messageId, receipt.messageId);
    assert.equal(c.ready.payload.snapshot.pin?.message.id, receipt.messageId);
    assert.ok(c.ready.payload.snapshot.memberEvents?.some(event => event.user.id === credential.self.id && event.kind === "returned"));
    c.client.send("message.send", continuation, credential.epochId);
    const retry = (await c.client.wait("message.accepted")).payload;
    assert.equal(retry.duplicate, true);
    assert.equal(retry.messageId, continued.messageId);
    c.client.send("room.sync", { roomId: "lobby" }, credential.epochId);
    assert.equal((await c.client.wait("room.snapshot")).payload.snapshot.messages.length, 2);
  } finally {
    for (const client of clients) client.socket.terminate();
    for (const process of processes) await process.stop("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
});

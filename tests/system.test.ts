import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { WebSocket as NativeSocket } from "ws";
import { ChatController, type ControllerNavigation } from "../client/src/app/controller.js";
import { HttpClient } from "../client/src/services/http.js";
import { RealtimeClient } from "../client/src/services/realtime.js";
import { BrowserStorage, type StoragePort } from "../client/src/services/storage.js";
import { SoundService } from "../client/src/services/sound.js";
import { createChatServer, type ChatServerOptions } from "../server/app.js";
import type { ChatView, MessageView } from "../shared/ui.js";
import type { ServerEvent } from "../shared/ws.js";

class MemoryStorage implements StoragePort {
  private readonly data = new Map<string, string>();
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

function navigation(): ControllerNavigation {
  return {
    bindings: { viewportRef: () => {}, rowRef: () => () => {}, onScroll: () => {} },
    state: () => ({ atBottom: true, unseenIncomingCount: 0, navigationMode: "following", canReturnToReadingPosition: false, highlightedMessageId: null }),
    beforeUpdate: () => {}, afterUpdate: () => {}, jumpToMessage: () => true,
    jumpToLatest: () => {}, restoreReadingPosition: () => true, dispose: () => {},
  };
}

const controllers: ChatController[] = [];
const sockets: NativeSocket[] = [];
const transports = new Map<ChatController, RealtimeClient>();
const observations = new Map<ChatController, ServerEvent[]>();
let application: ReturnType<typeof createChatServer> | null;
let address: Awaited<ReturnType<ReturnType<typeof createChatServer>["listen"]>>;
let browserSocketDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  browserSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  class BrowserSocket extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { origin: address.origin });
      sockets.push(this);
      this.on("error", () => {});
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: BrowserSocket });
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const socket of sockets.splice(0)) socket.terminate();
  transports.clear(); observations.clear();
  await application?.close(); application = null;
  if (browserSocketDescriptor) Object.defineProperty(globalThis, "WebSocket", browserSocketDescriptor);
  else Reflect.deleteProperty(globalThis, "WebSocket");
});

async function start(options: ChatServerOptions = {}): Promise<void> {
  application = createChatServer({ staticDir: false, rateLimits: { session: 100, connection: 100, message: 100, frame: 1000 }, ...options });
  address = await application.listen();
}
function createController(session = new MemoryStorage(), preferences = new MemoryStorage()): { controller: ChatController; storage: BrowserStorage } {
  const storage = new BrowserStorage(address.origin, { sessionStorage: session, localStorage: preferences });
  const events: ServerEvent[] = [];
  let realtime!: RealtimeClient;
  const controller = new ChatController({
    apiOrigin: address.origin, http: new HttpClient(address.origin), storage, navigation: navigation(), confirm: () => false,
    sound: new SoundService({ createAudio: () => ({ currentTime: 0, play: async () => {}, pause: () => {} }) }),
    transportFactory: handlers => {
      realtime = new RealtimeClient(address.origin, { ...handlers, onEvent: event => { events.push(event); handlers.onEvent(event); } });
      return realtime;
    },
  });
  transports.set(controller, realtime); observations.set(controller, events); controllers.push(controller);
  controller.start();
  return { controller, storage };
}
function chat(controller: ChatController): ChatView {
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.screen, "chat");
  if (snapshot.screen !== "chat") throw new Error("The chat screen is unavailable.");
  return snapshot.chat;
}
function messages(controller: ChatController): MessageView[] {
  return chat(controller).timeline.items.flatMap(item => item.type === "message" && !item.message.systemEvent ? [item.message] : []);
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function join(controller: ChatController, name: string): Promise<void> {
  controller.onJoinDisplayNameChange(name); controller.onJoinSubmit();
  await ready(controller);
}
async function ready(controller: ChatController): Promise<void> {
  await until(() => { const view = controller.getSnapshot(); return view.screen === "chat" && view.chat.connection.phase === "ready"; }, "authenticated room snapshot");
}
function send(controller: ChatController, text: string): void {
  controller.callbacks.onDraftIntent({ type: "text.changed", value: text });
  controller.callbacks.onSubmit({ draftRevision: chat(controller).composer.draft.revision, trigger: "button" });
}

test("a real in-flight send reconciles after reload without clearing a later draft or replaying the operation", async () => {
  await start();
  const aliceSession = new MemoryStorage(), alicePreferences = new MemoryStorage();
  const { controller: alice, storage } = createController(aliceSession, alicePreferences);
  const { controller: bob } = createController();
  await join(alice, "Alice"); await join(bob, "Bob");
  const identity = chat(alice).self.id;
  bob.callbacks.onDraftIntent({ type: "text.changed", value: "A separate Bob draft" });
  alice.callbacks.onDraftIntent({ type: "mode.changed", value: "code" });
  alice.callbacks.onDraftIntent({ type: "language.changed", value: "typescript" });
  alice.callbacks.onDraftIntent({ type: "code.changed", value: "\tconst retained = true;\n" });
  alice.callbacks.onDraftIntent({ type: "mode.changed", value: "text" });
  send(alice, "Committed through the real transport");
  alice.callbacks.onDraftIntent({ type: "text.changed", value: "A draft typed after submission" });
  const pending = messages(alice).find(message => message.identity.kind === "outbox");
  assert.equal(pending?.delivery.phase, "sending");
  alice.stop();
  const credential = storage.readSession(); assert.ok(credential);
  assert.equal(storage.readOutbox(credential)[0]?.delivery.phase, "unknown");
  await until(() => messages(bob).length === 1, "server transaction despite the closing sender");
  const { controller: restored } = createController(aliceSession, alicePreferences);
  await ready(restored);
  assert.equal(chat(restored).self.id, identity);
  assert.equal(chat(restored).composer.draft.textBuffer, "A draft typed after submission");
  assert.equal(chat(restored).composer.draft.codeBuffer.source, "\tconst retained = true;\n");
  assert.equal(chat(restored).composer.draft.codeBuffer.language, "typescript");
  assert.equal(chat(bob).composer.draft.textBuffer, "A separate Bob draft");
  assert.equal(messages(restored).length, 1);
  assert.equal(messages(restored)[0]?.identity.kind, "canonical");
  assert.equal(application?.room.messages.length, 1);
  assert.equal(storage.readOutbox(credential).length, 0);
});

test("real buffered data and a stale socket close cannot replace a newer authenticated connection", async () => {
  await start();
  const { controller: alice } = createController(), { controller: bob } = createController();
  await join(alice, "Alice"); await join(bob, "Bob");
  const previous = sockets[0]; assert.ok(previous);
  const wire = (previous as NativeSocket & { _socket: Socket })._socket;
  wire.pause();
  let delayedFrames = 0;
  previous.on("message", () => { delayedFrames += 1; });
  send(bob, "A real message buffered on the earlier connection");
  await until(() => messages(bob).some(message => message.identity.kind === "canonical"), "authoritative first transaction");
  assert.equal(messages(alice).length, 0);
  const closed = new Promise<void>(resolve => previous.once("close", () => resolve()));
  alice.callbacks.onRetryConnection();
  await ready(alice);
  assert.equal(messages(alice).length, 1);
  wire.resume();
  await closed;
  assert.ok(delayedFrames > 0);
  assert.equal(chat(alice).connection.phase, "ready");
  assert.equal(messages(alice).length, 1);
  send(bob, "The active connection still receives transactions");
  await until(() => messages(alice).length === 2, "current socket remains live after the stale close");
  assert.equal(chat(alice).members.length, 2);
});

test("real accepted-operation retries remain available after the logical-message rate limit is reached", async () => {
  await start({ rateLimits: { session: 100, connection: 100, message: 1, frame: 1000 } });
  const { controller } = createController(); await join(controller, "Alice");
  send(controller, "A bounded logical write");
  await until(() => application?.room.messages.length === 1 && messages(controller)[0]?.identity.kind === "canonical", "first operation accepted");
  const message = application?.room.messages[0]; assert.ok(message);
  const transport = transports.get(controller); assert.ok(transport);
  assert.equal(transport.send({ v: 1, type: "message.send", requestId: randomUUID(), epochId: message.epochId,
    payload: { operationId: message.clientOperationId, roomId: "lobby", content: message.content, replyToId: null } }), true);
  await until(() => observations.get(controller)?.some(event => event.type === "message.accepted" && event.payload.duplicate) === true, "duplicate receipt without a new write allowance");
  send(controller, "A separate operation exceeds the write allowance");
  await until(() => messages(controller).some(item => item.delivery.phase === "rejected"), "rate rejection projected by the production controller");
  const rejected = messages(controller).find(item => item.delivery.phase === "rejected");
  assert.equal(rejected?.delivery.phase === "rejected" ? rejected.delivery.error.code : undefined, "RATE_LIMITED");
  assert.equal(application?.room.messages.length, 1);
});

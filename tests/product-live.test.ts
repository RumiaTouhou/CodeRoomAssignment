import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { createChatServer } from "../server/app.js";
import { ChatController } from "../client/src/app/controller.js";
import { HttpClient } from "../client/src/services/http.js";
import { RealtimeClient } from "../client/src/services/realtime.js";
import { BrowserStorage, type StoragePort } from "../client/src/services/storage.js";
import type { ChatView, MessageView } from "../shared/ui.js";

class MemoryStorage implements StoragePort {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function chat(controller: ChatController): ChatView {
  const view = controller.getSnapshot();
  if (view.screen !== "chat") throw new Error("Chat is not active");
  return view.chat;
}
function messages(controller: ChatController): MessageView[] {
  return chat(controller).timeline.items.flatMap(item => item.type === "message" && !item.message.systemEvent ? [item.message] : []);
}
async function until(check: () => boolean, timeout = 4000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("The expected live state was not reached");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("two live controllers exchange code, typing, replies, reactions and searches across reload and reconnect", async () => {
  const origin = "https://chat.example";
  const service = createChatServer({ staticDir: false, allowedOrigins: [origin] });
  const address = await service.listen();
  const originalSocket = globalThis.WebSocket;
  const sockets: WebSocket[] = [];
  class BrowserSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url, { origin });
      this.on("error", () => {});
      sockets.push(this);
    }
  }
  globalThis.WebSocket = BrowserSocket as unknown as typeof globalThis.WebSocket;
  const controllers: ChatController[] = [];
  const create = (storage = new BrowserStorage(address.origin, { sessionStorage: new MemoryStorage(), localStorage: new MemoryStorage() })) => {
    let incoming = 0;
    const controller = new ChatController({
      apiOrigin: address.origin,
      http: new HttpClient(address.origin), storage,
      transportFactory: handlers => new RealtimeClient(address.origin, handlers),
      sound: { view: () => ({ mode: "off", playback: "not-enabled" }), restore: () => {}, setMode: async () => {}, preview: async () => {}, receive: () => { incoming++; }, dispose: () => {} },
      confirm: () => true,
      navigation: {
        bindings: { viewportRef: () => {}, rowRef: () => () => {}, onScroll: () => {} },
        state: () => ({ atBottom: true, unseenIncomingCount: 0, navigationMode: "following", canReturnToReadingPosition: false, highlightedMessageId: null }),
        beforeUpdate: () => {}, afterUpdate: () => {}, jumpToMessage: () => true, jumpToLatest: () => {}, restoreReadingPosition: () => true, dispose: () => {},
      },
    });
    controllers.push(controller);
    controller.start();
    return { controller, storage, incoming: () => incoming };
  };
  const join = async (controller: ChatController, name: string) => {
    controller.onJoinDisplayNameChange(name); controller.onJoinSubmit();
    await until(() => { const state = controller.getSnapshot(); return state.screen === "chat" && state.chat.connection.phase === "ready"; });
  };
  const sendText = (controller: ChatController, text: string) => {
    controller.callbacks.onDraftIntent({ type: "mode.changed", value: "text" });
    controller.callbacks.onDraftIntent({ type: "text.changed", value: text });
    controller.submit({ draftRevision: chat(controller).composer.draft.revision, trigger: "button" });
  };
  try {
    const alice = create(), bob = create();
    await join(alice.controller, "Alice"); await join(bob.controller, "Bob");
    await until(() => chat(alice.controller).members.length === 2 && chat(bob.controller).members.length === 2);
    assert.notEqual(chat(alice.controller).self.id, chat(bob.controller).self.id);

    alice.controller.callbacks.onComposerFocusChange(true);
    alice.controller.callbacks.onDraftIntent({ type: "text.changed", value: "Typing a draft" });
    await until(() => chat(bob.controller).typing.users.some(user => user.displayName === "Alice"));
    alice.controller.callbacks.onShareTypingChange(false);
    await until(() => chat(bob.controller).typing.users.length === 0);

    const source = '\texport const value = "<div>literal</div>";\n\t// **plain** 😀\n';
    alice.controller.callbacks.onDraftIntent({ type: "mode.changed", value: "code" });
    alice.controller.callbacks.onDraftIntent({ type: "language.changed", value: "typescript" });
    alice.controller.callbacks.onDraftIntent({ type: "code.changed", value: source });
    alice.controller.submit({ draftRevision: chat(alice.controller).composer.draft.revision, trigger: "button" });
    await until(() => messages(alice.controller)[0]?.identity.kind === "canonical" && messages(bob.controller).length === 1);
    const code = messages(bob.controller)[0]; assert.ok(code);
    assert.equal(code.content.kind === "code" ? code.content.source : null, source);
    assert.equal(alice.incoming(), 0); assert.equal(bob.incoming(), 1);
    assert.equal(code.identity.kind, "canonical"); if (code.identity.kind !== "canonical") return;
    const codeId = code.identity.messageId;

    bob.controller.callbacks.onReply(codeId);
    sendText(bob.controller, "Looks good");
    await until(() => messages(alice.controller).length === 2 && messages(bob.controller)[1]?.identity.kind === "canonical");
    assert.equal(messages(alice.controller)[1]?.quote?.messageId, codeId);
    assert.equal(messages(alice.controller)[1]?.quote?.previewText, [...source].slice(0, 160).join(""));

    bob.controller.callbacks.onSetReaction(codeId, "✅", true);
    await until(() => messages(alice.controller)[0]?.reactions.some(reaction => reaction.emoji === "✅" && reaction.count === 1) ?? false);
    await until(() => messages(bob.controller)[0]?.reactions.some(reaction => reaction.emoji === "✅" && reaction.reactedByMe && !reaction.pending) ?? false);
    assert.equal(alice.incoming(), 1); assert.equal(bob.incoming(), 1);

    sendText(alice.controller, "First follow-up"); sendText(alice.controller, "Second follow-up");
    await until(() => messages(bob.controller).length === 4 && messages(alice.controller).every(message => message.identity.kind === "canonical"));
    assert.equal(messages(bob.controller)[3]?.grouping, "continuation");
    assert.equal(new Set(messages(bob.controller).map(message => message.key)).size, 4);

    bob.controller.callbacks.onOpenSearch(); bob.controller.callbacks.onSearchQueryChange("follow-up");
    await until(() => chat(bob.controller).search.phase === "results");
    const search = chat(bob.controller).search;
    assert.equal(search.phase === "results" ? search.response.totalMatches : 0, 2);

    bob.controller.callbacks.onDraftIntent({ type: "text.changed", value: "Survives reload" });
    bob.controller.stop();
    const restored = create(bob.storage);
    await until(() => chat(restored.controller).connection.phase === "ready");
    assert.equal(chat(restored.controller).composer.draft.textBuffer, "Survives reload");
    assert.equal(messages(restored.controller).length, 4); assert.equal(restored.incoming(), 0);

    const connection = sockets.at(-1); assert.ok(connection); connection.terminate();
    await until(() => chat(restored.controller).connection.phase === "reconnecting");
    sendText(alice.controller, "Received through the reconnect snapshot");
    await until(() => chat(restored.controller).connection.phase === "ready" && messages(restored.controller).length === 5);
    assert.equal(chat(restored.controller).composer.draft.textBuffer, "Survives reload");
    assert.equal(restored.incoming(), 0);

    const credential = bob.storage.readSession(); assert.ok(credential);
    const copiedStorage = new BrowserStorage(address.origin, { sessionStorage: new MemoryStorage(), localStorage: new MemoryStorage() });
    copiedStorage.writeSession(credential);
    const takeover = create(copiedStorage);
    await until(() => chat(takeover.controller).connection.phase === "ready" && chat(restored.controller).connection.phase === "ended");
    const ended = chat(restored.controller).connection;
    assert.equal(ended.phase === "ended" ? ended.reason : null, "replaced");
    assert.equal(chat(takeover.controller).self.id, chat(restored.controller).self.id);
  } finally {
    for (const controller of controllers) controller.stop();
    for (const socket of sockets) socket.terminate();
    globalThis.WebSocket = originalSocket;
    await service.close();
  }
});

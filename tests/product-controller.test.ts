import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ChatController, type ControllerOptions } from "../client/src/app/controller.js";
import { SoundService } from "../client/src/services/sound.js";
import { defaultPreferences, emptyDraft } from "../client/src/services/storage.js";
import type { RealtimeHandlers } from "../client/src/services/realtime.js";
import type { ChatMessage, HistoryWindow, RoomSnapshot } from "../shared/domain.js";
import type { SearchResponse, SessionCredential } from "../shared/http.js";
import type { OutboxEntry } from "../shared/persistence.js";
import type { ChatView, ComposerDraft, LocalPreferences } from "../shared/ui.js";
import type { ClientEvent, ServerEvent } from "../shared/ws.js";
import { LIMITS } from "../shared/limits.js";
import { utf8Bytes } from "../shared/validation.js";

function history(messages: readonly ChatMessage[]): HistoryWindow {
  return { retainedCount: messages.length, limit: LIMITS.historyMessages, serializedBytes: utf8Bytes(JSON.stringify(messages)), maxSerializedBytes: LIMITS.historyJsonUtf8Bytes,
    oldestSequence: messages[0]?.sequence ?? null, newestSequence: messages.at(-1)?.sequence ?? null, persistence: "memory-until-server-restart" };
}

function setup(entries: readonly OutboxEntry[] = [], options: { isForeground?: () => boolean; soundMode?: LocalPreferences["soundMode"]; sound?: ControllerOptions["sound"] } = {}) {
  let at = 100000;
  const credential: SessionCredential = { protocolVersion: 1, epochId: randomUUID(), roomId: "lobby", self: { id: randomUUID(), displayName: "Alice", avatarSeed: "alice" }, bearerToken: "a".repeat(64), expiresAt: 10000000 };
  let storedDraft: ComposerDraft | null = null;
  let preferences: LocalPreferences = { ...defaultPreferences(), soundMode: options.soundMode ?? "off" };
  let soundMode: LocalPreferences["soundMode"] = "off";
  let outbox: readonly OutboxEntry[] = entries;
  const sent: ClientEvent[] = [];
  let handlers!: RealtimeHandlers;
  let receives = 0;
  const navigations: { epochId: string; messages: readonly ChatMessage[]; newIncomingIds?: readonly string[] }[] = [];
  let latestJumps = 0;
  const navigationState = { atBottom: true, unseenIncomingCount: 0, navigationMode: "following" as "following" | "reading" | "search" | "quote", canReturnToReadingPosition: false, highlightedMessageId: null as string | null };
  const searchCalls: { query: string; resolve: (value: SearchResponse) => void; signal: AbortSignal | undefined }[] = [];
  const controller = new ChatController({
    apiOrigin: "http://localhost", now: () => at, confirm: () => false, ...(options.isForeground ? { isForeground: options.isForeground } : {}),
    storage: {
      readSession: () => credential, writeSession: () => true, clearSession: () => {},
      readDraft: () => storedDraft, writeDraft: (_credential, draft) => { storedDraft = draft; return true; },
      readOutbox: () => outbox, writeOutbox: (_credential, entries) => { outbox = entries; return true; },
      readPreferences: () => preferences, writePreferences: value => { preferences = value; return true; }, available: () => true,
    },
    sound: options.sound ?? { view: () => ({ mode: soundMode, playback: soundMode === "incoming" ? "unverified" : "not-enabled" }), restore: mode => { soundMode = mode; }, setMode: async mode => { soundMode = mode; }, preview: async () => {}, receive: () => { receives++; }, dispose: () => { soundMode = "off"; } },
    navigation: {
      bindings: { viewportRef: () => {}, rowRef: () => () => {}, onScroll: () => {} },
      state: () => navigationState,
      beforeUpdate: () => {}, afterUpdate: data => { navigations.push(data); }, jumpToMessage: () => true, jumpToLatest: () => { latestJumps++; }, restoreReadingPosition: () => true, dispose: () => {},
    },
    transportFactory: callbacks => { handlers = callbacks; return { connect: () => handlers.onOpen(), disconnect: () => {}, send: event => { sent.push(event); return true; } }; },
    http: {
      createSession: async () => credential, revokeSession: async () => {},
      search: (_credential, input, signal) => new Promise(resolve => { searchCalls.push({ query: input.query, resolve, signal }); }),
    },
  });
  const room = (messages: readonly ChatMessage[] = []): RoomSnapshot => ({ roomId: "lobby", epochId: credential.epochId, revision: messages.at(-1)?.mutationRevision ?? 0, capturedAt: at,
    messages, history: history(messages), presence: { version: 1, members: [credential.self] }, typing: { version: 0, entries: [] } });
  const envelope = <T extends ServerEvent["type"]>(type: T, payload: Extract<ServerEvent, { type: T }>["payload"]): ServerEvent => ({ v: 1, type, epochId: credential.epochId, serverTime: at, payload, ...(["session.ready", "room.snapshot", "message.accepted", "reaction.accepted"].includes(type) ? { requestId: randomUUID() } : {}) } as ServerEvent);
  const ready = (snapshot = room()) => controller.receive(envelope("session.ready", { connectionId: randomUUID(), self: credential.self, expiresAt: credential.expiresAt,
    limits: { messageBodyUtf8Bytes: LIMITS.messageBodyUtf8Bytes, historyMessages: LIMITS.historyMessages, historyJsonUtf8Bytes: LIMITS.historyJsonUtf8Bytes, searchResults: LIMITS.searchResults, typingTtlMs: LIMITS.typingTtlMs, ackTimeoutMs: LIMITS.ackTimeoutMs }, snapshot }));
  const chat = (): ChatView => { const view = controller.getSnapshot(); assert.equal(view.screen, "chat"); if (view.screen !== "chat") throw new Error("Chat not active"); return view.chat; };
  const sendDraft = (text: string) => { controller.callbacks.onDraftIntent({ type: "text.changed", value: text }); controller.submit({ draftRevision: chat().composer.draft.revision, trigger: "button" }); };
  const makeMessage = (sequence: number, operationId: string = randomUUID(), own = true): ChatMessage => ({ id: randomUUID(), roomId: "lobby", epochId: credential.epochId, clientOperationId: operationId,
    author: own ? credential.self : { id: randomUUID(), displayName: "Bob", avatarSeed: "bob" }, sequence, createdAt: at, content: { kind: "text", text: `Message ${sequence}` }, reply: null, reactions: [], mutationRevision: sequence });
  controller.start(); ready();
  return { controller, credential, sent, chat, room, envelope, ready, sendDraft, makeMessage, handlers: () => handlers, receives: () => receives, advance: (duration: number) => { at += duration; }, navigations, searchCalls, navigationState, latestJumps: () => latestJumps };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a saved incoming preference restores the real sound service across controller lifecycles", async () => {
  let plays = 0;
  const sound = new SoundService({ createAudio: () => ({ currentTime: 0, play: async () => { plays++; }, pause: () => {} }) });
  const app = setup([], { sound, soundMode: "incoming", isForeground: () => false });
  try {
    assert.deepEqual(sound.view(), { mode: "incoming", playback: "unverified" });
    assert.equal(app.chat().sound.mode, "incoming"); assert.equal(plays, 0);
    const first = app.makeMessage(1, randomUUID(), false);
    app.controller.receive(app.envelope("room.delta", { roomId: "lobby", revision: 1, change: { kind: "message.created", message: first }, evictedMessageIds: [], history: history([first]) }));
    await Promise.resolve(); assert.equal(plays, 1); assert.equal(sound.view().playback, "ready");
    app.controller.stop(); assert.equal(sound.view().mode, "off");
    app.controller.start(); app.ready(app.room([first])); assert.equal(plays, 1);
    assert.deepEqual(sound.view(), { mode: "incoming", playback: "unverified" });
    const second = app.makeMessage(2, randomUUID(), false);
    app.controller.receive(app.envelope("room.delta", { roomId: "lobby", revision: 2, change: { kind: "message.created", message: second }, evictedMessageIds: [], history: history([first, second]) }));
    await Promise.resolve(); assert.equal(plays, 2);
  } finally { app.controller.stop(); }
});

test("a later incoming message can recover from an autoplay block without toggling sound", async () => {
  let plays = 0, allowed = false, at = 1000;
  const sound = new SoundService({ now: () => at, createAudio: () => ({ currentTime: 0, pause: () => {}, play: () => {
    plays++;
    return allowed ? Promise.resolve() : Promise.reject(Object.assign(new Error("Denied"), { name: "NotAllowedError" }));
  } }) });
  const app = setup([], { sound, soundMode: "incoming", isForeground: () => false });
  try {
    const first = app.makeMessage(1, randomUUID(), false);
    app.controller.receive(app.envelope("room.delta", { roomId: "lobby", revision: 1, change: { kind: "message.created", message: first }, evictedMessageIds: [], history: history([first]) }));
    await Promise.resolve(); assert.equal(sound.view().playback, "blocked"); assert.equal(plays, 1);
    allowed = true; at += LIMITS.soundCooldownMs;
    const second = app.makeMessage(2, randomUUID(), false);
    app.controller.receive(app.envelope("room.delta", { roomId: "lobby", revision: 2, change: { kind: "message.created", message: second }, evictedMessageIds: [], history: history([first, second]) }));
    await Promise.resolve(); assert.equal(plays, 2);
    assert.deepEqual(sound.view(), { mode: "incoming", playback: "ready" });
    assert.equal(app.chat().preferences.soundMode, "incoming");
  } finally { app.controller.stop(); }
});

test("ACK arriving before the broadcast cannot clear a newer draft or create duplicate rows", () => {
  const app = setup();
  try {
    app.sendDraft("A");
    const sent = app.sent.find(event => event.type === "message.send"); assert.equal(sent?.type, "message.send"); if (sent?.type !== "message.send") return;
    app.controller.callbacks.onDraftIntent({ type: "text.changed", value: "B" });
    const message = { ...app.makeMessage(1, sent.payload.operationId), content: sent.payload.content };
    app.controller.receive(app.envelope("message.accepted", { operationId: sent.payload.operationId, messageId: message.id, sequence: 1, acceptedAt: 100000, appliedRevision: 1, duplicate: false, retained: true }));
    assert.equal(app.chat().composer.draft.textBuffer, "B");
    assert.equal(app.chat().connection.phase, "synchronizing");
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.room([message]) }));
    const rows = app.chat().timeline.items.filter(item => item.type === "message");
    assert.equal(rows.length, 1); assert.equal(app.chat().composer.draft.textBuffer, "B"); assert.equal(app.receives(), 0);
  } finally { app.controller.stop(); }
});

test("timeout becomes unknown and manual retry preserves operation identity with a fresh request ID", async () => {
  const app = setup();
  try {
    app.sendDraft("A"); app.advance(LIMITS.ackTimeoutMs + 1); await wait(270);
    const row = app.chat().timeline.items.find(item => item.type === "message"); assert.equal(row?.type, "message"); if (row?.type !== "message") return;
    assert.equal(row.message.delivery.phase, "unknown"); assert.equal(row.message.identity.kind, "outbox"); if (row.message.identity.kind !== "outbox") return;
    app.controller.callbacks.onRetryMessage(row.message.identity.operationId);
    const sends = app.sent.filter(event => event.type === "message.send"); assert.equal(sends.length, 2);
    assert.equal(sends[0]?.payload.operationId, sends[1]?.payload.operationId); assert.notEqual(sends[0]?.requestId, sends[1]?.requestId);
  } finally { app.controller.stop(); }
});

test("disconnection and full-snapshot reconnect do not automatically resend an uncertain message", () => {
  const app = setup();
  try {
    app.sendDraft("A"); app.handlers().onClose();
    assert.equal(app.chat().connection.phase, "reconnecting");
    app.controller.callbacks.onRetryConnection(); app.ready();
    assert.equal(app.sent.filter(event => event.type === "message.send").length, 1);
    const row = app.chat().timeline.items.find(item => item.type === "message"); assert.equal(row?.type === "message" ? row.message.delivery.phase : null, "unknown");
  } finally { app.controller.stop(); }
});

test("only a new live incoming message emits a receive sound and an unread candidate", () => {
  const app = setup();
  try {
    const initial = app.makeMessage(1, randomUUID(), false); app.ready(app.room([initial])); app.controller.flushLayout(); assert.equal(app.receives(), 0);
    const message = app.makeMessage(2, randomUUID(), false);
    const delta = { roomId: "lobby" as const, revision: 2, change: { kind: "message.created" as const, message }, evictedMessageIds: [], history: history([initial, message]) };
    app.controller.receive(app.envelope("room.delta", delta)); app.controller.receive(app.envelope("room.delta", delta));
    app.controller.flushLayout();
    assert.equal(app.receives(), 1); assert.deepEqual(app.navigations.at(-1)?.newIncomingIds, [message.id]);
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.room([initial, message]) })); assert.equal(app.receives(), 1);
  } finally { app.controller.stop(); }
});

test("late search responses cannot replace the active query", async () => {
  const app = setup();
  try {
    app.controller.callbacks.onOpenSearch(); app.controller.callbacks.onSearchQueryChange("first"); await wait(LIMITS.searchDebounceMs + 30);
    app.controller.callbacks.onSearchQueryChange("second"); await wait(LIMITS.searchDebounceMs + 30);
    assert.equal(app.searchCalls.length, 2); assert.equal(app.searchCalls[0]?.signal?.aborted, true);
    const response = (query: string): SearchResponse => ({ epochId: app.credential.epochId, roomId: "lobby", query, asOfRevision: 0, searchedAt: 100000, history: history([]), totalMatches: 0, truncated: false, results: [] });
    app.searchCalls[1]?.resolve(response("second")); await wait(0);
    app.searchCalls[0]?.resolve(response("first")); await wait(0);
    assert.equal(app.chat().search.query, "second"); assert.equal(app.chat().search.phase, "empty");
  } finally { app.controller.stop(); }
});

test("IME composition and legacy composition key codes never submit", () => {
  const app = setup();
  try {
    app.controller.callbacks.onDraftIntent({ type: "text.changed", value: "Text" });
    const key = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, legacyKeyCode: 13 };
    assert.equal(app.controller.callbacks.onComposerKey({ ...key, isComposing: true }), false);
    assert.equal(app.controller.callbacks.onComposerKey({ ...key, legacyKeyCode: 229 }), false);
    app.controller.callbacks.onCompositionChange(true); assert.equal(app.controller.callbacks.onComposerKey(key), false);
    assert.equal(app.sent.filter(event => event.type === "message.send").length, 0);
  } finally { app.controller.stop(); }
});

test("confirmed messages outside retained history do not permanently fill the pending-send capacity", () => {
  const app = setup();
  try {
    for (let count = 0; count < LIMITS.pendingMessages; count++) {
      app.sendDraft(`Message ${count}`);
      const sent = app.sent.filter(event => event.type === "message.send").at(-1); assert.ok(sent);
      app.controller.receive(app.envelope("message.accepted", { operationId: sent.payload.operationId, messageId: randomUUID(), sequence: count + 1, acceptedAt: 100000, appliedRevision: count + 1, duplicate: true, retained: false }));
    }
    app.controller.callbacks.onDraftIntent({ type: "text.changed", value: "Next message" });
    assert.equal(app.chat().composer.canSubmit, true);
    app.controller.submit({ draftRevision: app.chat().composer.draft.revision, trigger: "button" });
    assert.equal(app.sent.filter(event => event.type === "message.send").length, LIMITS.pendingMessages + 1);
  } finally { app.controller.stop(); }
});


test("sending while reading, searching or viewing a quote preserves the active navigation mode", () => {
  for (const mode of ["reading", "search", "quote"] as const) {
    const app = setup();
    try {
      app.navigationState.navigationMode = mode; app.navigationState.atBottom = false;
      app.sendDraft("Keeps the reading position");
      assert.equal(app.latestJumps(), 0);
      assert.equal(app.chat().timeline.navigationMode, mode);
    } finally { app.controller.stop(); }
  }
});

test("a late request error cannot downgrade an authoritative accepted receipt", () => {
  const app = setup();
  try {
    app.sendDraft("A");
    const sent = app.sent.find(event => event.type === "message.send"); assert.ok(sent); if (sent.type !== "message.send") return;
    app.controller.receive(app.envelope("message.accepted", { operationId: sent.payload.operationId, messageId: randomUUID(), sequence: 1, acceptedAt: 100000, appliedRevision: 1, duplicate: true, retained: false }));
    app.controller.receive(app.envelope("request.error", { requestId: sent.requestId, operationId: sent.payload.operationId,
      error: { code: "INTERNAL_ERROR", message: "An earlier attempt was uncertain", retryable: true, outcome: "unknown" } }));
    const row = app.chat().timeline.items.find(item => item.type === "message");
    assert.equal(row?.type === "message" ? row.message.delivery.phase : null, "accepted-outside-history");
  } finally { app.controller.stop(); }
});

test("focused conversations suppress automatic sound while background live messages notify", () => {
  let foreground = true;
  const app = setup([], { isForeground: () => foreground });
  try {
    const first = app.makeMessage(1, randomUUID(), false);
    app.controller.receive(app.envelope("room.delta", { roomId: "lobby", revision: 1, change: { kind: "message.created", message: first }, evictedMessageIds: [], history: history([first]) }));
    assert.equal(app.receives(), 0);
    foreground = false;
    const second = app.makeMessage(2, randomUUID(), false);
    app.controller.receive(app.envelope("room.delta", { roomId: "lobby", revision: 2, change: { kind: "message.created", message: second }, evictedMessageIds: [], history: history([first, second]) }));
    assert.equal(app.receives(), 1);
  } finally { app.controller.stop(); }
});

test("remote typing leases tolerate clock skew and expire on the local monotonic clock", async () => {
  const app = setup();
  try {
    const user = { id: randomUUID(), displayName: "Bob", avatarSeed: "bob" };
    const initial = app.room(); app.ready({ ...initial, presence: { version: 2, members: [app.credential.self, user] } });
    const typing = app.envelope("typing.state", { version: 1, entries: [{ userId: user.id, expiresAt: 1500 }] });
    app.controller.receive({ ...typing, serverTime: 500 });
    assert.deepEqual(app.chat().typing.users.map(member => member.id), [user.id]);
    app.advance(1100); await wait(270);
    assert.equal(app.chat().typing.users.length, 0);
  } finally { app.controller.stop(); }
});

test("restoring a rejected message cannot overwrite a nonempty inactive draft buffer without confirmation", () => {
  const app = setup();
  try {
    app.controller.callbacks.onDraftIntent({ type: "mode.changed", value: "code" });
    app.controller.callbacks.onDraftIntent({ type: "code.changed", value: "Failed code" });
    app.controller.submit({ draftRevision: app.chat().composer.draft.revision, trigger: "button" });
    const sent = app.sent.find(event => event.type === "message.send"); assert.ok(sent); if (sent.type !== "message.send") return;
    app.controller.receive(app.envelope("request.error", { requestId: sent.requestId, operationId: sent.payload.operationId,
      error: { code: "RATE_LIMITED", message: "Try later", retryable: true, outcome: "not-applied" } }));
    app.controller.callbacks.onDraftIntent({ type: "code.changed", value: "Preserve this code buffer" });
    app.controller.callbacks.onDraftIntent({ type: "mode.changed", value: "text" });
    assert.equal(app.chat().composer.draft.textBuffer, "");
    app.controller.callbacks.onRestoreToComposer(sent.payload.operationId);
    assert.equal(app.chat().composer.draft.codeBuffer.source, "Preserve this code buffer");
    assert.equal(app.chat().composer.draft.mode, "text");
  } finally { app.controller.stop(); }
});

test("snapshots preserve queued live unread candidates without adding historical or evicted messages", () => {
  const app = setup();
  try {
    const live = app.makeMessage(1, randomUUID(), false);
    const historical = app.makeMessage(2, randomUUID(), false);
    app.controller.receive(app.envelope("room.delta", { roomId: "lobby", revision: 1, change: { kind: "message.created", message: live }, evictedMessageIds: [], history: history([live]) }));
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.room([live, historical]) }));
    app.controller.flushLayout();
    assert.deepEqual(app.navigations.at(-1)?.newIncomingIds, [live.id]);
    assert.equal(app.receives(), 1);
  } finally { app.controller.stop(); }

  const pruned = setup();
  try {
    const live = pruned.makeMessage(1, randomUUID(), false);
    const retained = pruned.makeMessage(2, randomUUID(), false);
    pruned.controller.receive(pruned.envelope("room.delta", { roomId: "lobby", revision: 1, change: { kind: "message.created", message: live }, evictedMessageIds: [], history: history([live]) }));
    pruned.controller.receive(pruned.envelope("room.snapshot", { snapshot: pruned.room([retained]) }));
    pruned.controller.flushLayout();
    assert.deepEqual(pruned.navigations.at(-1)?.newIncomingIds, []);
    assert.equal(pruned.receives(), 1);
  } finally { pruned.controller.stop(); }
});

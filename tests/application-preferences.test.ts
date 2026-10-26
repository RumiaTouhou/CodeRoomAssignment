import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ChatController } from "../client/src/app/controller.js";
import { BrowserStorage, defaultPreferences, type StoragePort } from "../client/src/services/storage.js";
import { SoundService } from "../client/src/services/sound.js";
import type { ChatMessage, PublicPin, SessionRole } from "../shared/domain.js";
import type { SearchResponse } from "../shared/http.js";
import type { ChatView, LocalPreferences, MessageView } from "../shared/ui.js";
import type { ClientEvent, ServerEvent } from "../shared/ws.js";
import { LIMITS } from "../shared/limits.js";
import { ALICE, BOB, SAMPLE_CREDENTIAL, SAMPLE_MESSAGES, SAMPLE_NOW, SAMPLE_PUBLIC_LIMITS, SAMPLE_SEARCH, snapshotFor } from "./fixtures/messages.js";

class Values implements StoragePort {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function setup(options: { preferences?: Partial<LocalPreferences>; foreground?: boolean; role?: SessionRole; confirm?: boolean; searchResponse?: SearchResponse } = {}) {
  let at = SAMPLE_NOW, plays = 0, captures = 0;
  const playedSources: string[] = [];
  const owner = { ...SAMPLE_CREDENTIAL, role: options.role ?? "guest" };
  const storage = new BrowserStorage("https://features.example", { sessionStorage: new Values(), localStorage: new Values(), now: () => at });
  storage.writeSession(owner);
  storage.writePreferences({ ...defaultPreferences(), soundMode: "incoming", ...options.preferences }, owner);
  const sent: ClientEvent[] = [];
  const jumps: { id: string; expanded: boolean }[] = [];
  const sound = new SoundService({ now: () => at, createAudio: source => ({ currentTime: 0, pause: () => {}, play: async () => { plays++; playedSources.push(source); } }) });
  const controller = new ChatController({ apiOrigin: "https://features.example", storage, sound, now: () => at, isForeground: () => options.foreground ?? false,
    confirm: () => options.confirm ?? true,
    http: { createSession: async () => owner, revokeSession: async () => {}, search: async () => options.searchResponse ?? SAMPLE_SEARCH },
    transportFactory: handlers => ({ connect: () => handlers.onOpen(), disconnect: () => {}, send: event => { sent.push(event); return true; } }),
    navigation: {
      bindings: { viewportRef: () => {}, rowRef: () => () => {}, onScroll: () => {} },
      state: () => ({ atBottom: false, unseenIncomingCount: 0, navigationMode: "reading", canReturnToReadingPosition: false, highlightedMessageId: null }),
      beforeUpdate: () => { captures++; }, afterUpdate: () => {},
      jumpToMessage: id => { jumps.push({ id, expanded: messages().find(message => message.identity.kind === "canonical" && message.identity.messageId === id)?.fold?.expanded ?? false }); return true; },
      jumpToLatest: () => {}, restoreReadingPosition: () => true, dispose: () => {},
    },
  });
  const chat = (): ChatView => { const state = controller.getSnapshot(); if (state.screen !== "chat") throw new Error("Chat is inactive"); return state.chat; };
  const messages = (): MessageView[] => chat().timeline.items.flatMap(item => item.type === "message" ? [item.message] : []);
  const envelope = <T extends ServerEvent["type"]>(type: T, payload: Extract<ServerEvent, { type: T }>["payload"]): ServerEvent => ({ v: 1, type, epochId: owner.epochId, serverTime: at, payload,
    ...(["session.ready", "room.snapshot", "pin.accepted"].includes(type) ? { requestId: randomUUID() } : {}) } as ServerEvent);
  const snapshot = (messages: readonly ChatMessage[], revision = 20, pin: PublicPin | null = null) => ({ ...snapshotFor(messages, revision), pin });
  const ready = (messages: readonly ChatMessage[], role: SessionRole = owner.role, pin: PublicPin | null = null) => controller.receive(envelope("session.ready", { connectionId: randomUUID(), self: owner.self, role, expiresAt: owner.expiresAt, limits: SAMPLE_PUBLIC_LIMITS, snapshot: snapshot(messages, 20, pin) }));
  controller.start(); ready([]);
  const message = (sequence: number, content: ChatMessage["content"]): ChatMessage => ({ ...SAMPLE_MESSAGES[0]!, id: randomUUID(), sequence, clientOperationId: randomUUID(), content, mutationRevision: sequence });
const member = (kind: "joined" | "left" | "returned", self = false, id = randomUUID(), displayNameChanged = false) => envelope("member.event", { id, kind, user: self ? ALICE : BOB, occurredAt: at, displayNameChanged });
  return { controller, storage, owner, chat, messages, envelope, snapshot, ready, message, member, sent, jumps, heard: () => [...playedSources], captures: () => captures, plays: () => plays, advance: (duration: number) => { at += duration; } };
}

test("fold boundaries count Unicode code points and preserve complete code and text", () => {
  const app = setup();
  try {
    const contents: ChatMessage["content"][] = [
      { kind: "text", text: Array(12).fill("Line").join("\n") },
      { kind: "text", text: Array(13).fill("Line").join("\n") },
      { kind: "text", text: "😀".repeat(1200) },
      { kind: "text", text: "😀".repeat(1201) },
      { kind: "code", source: Array(13).fill("\tconst value = '<div>literal</div>'; ").join("\n"), language: "typescript" },
    ];
    app.ready(contents.map((content, index) => app.message(index + 1, content)));
    assert.deepEqual(app.messages().map(message => message.fold?.collapsible), [false, true, false, true, true]);
    assert.deepEqual(app.messages().map(message => message.content), contents);
    assert.ok(app.messages().every(message => message.fold?.expanded === false));
  } finally { app.controller.stop(); }
});

test("context navigation expands folded targets before measuring and captures reading position on size changes", () => {
  const app = setup();
  try {
    const target = app.message(1, { kind: "text", text: "context ".repeat(200) });
    app.ready([target]);
    const row = app.messages()[0]!;
    app.controller.callbacks.onJumpToMessage(target.id, "search");
    assert.equal(app.messages()[0]!.fold?.expanded, true);
    assert.equal(app.jumps.length, 0);
    app.controller.flushLayout();
    assert.deepEqual(app.jumps, [{ id: target.id, expanded: true }]);
    const captures = app.captures();
    app.controller.callbacks.onToggleExpanded?.(row.key);
    assert.equal(app.messages()[0]!.fold?.expanded, false);
    app.controller.callbacks.onReadingSizeChange?.("larger");
    assert.equal(app.chat().preferences.readingSize, "larger");
    assert.ok(app.captures() >= captures + 2);
    assert.equal(app.storage.readPreferences(app.owner).readingSize, "larger");
  } finally { app.controller.stop(); }
});

test("bookmarks retain full immutable snapshots after source eviction and disable stale navigation", () => {
  const app = setup();
  try {
    const target = app.message(1, { kind: "code", language: "typescript", source: "\tconst exact = '**literal** 😀';\n".repeat(30) });
    app.ready([target]);
    app.controller.callbacks.onToggleBookmark?.(target.id);
    app.controller.callbacks.onOpenBookmarks?.();
    const saved = app.chat().bookmarks?.items[0]; assert.ok(saved);
    assert.deepEqual(saved.content, target.content);
    assert.deepEqual(saved.author, target.author);
    assert.equal(saved.createdAt, target.createdAt);
    assert.equal(saved.sourceAvailable, true);
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.snapshot([], 21) }));
    const retained = app.chat().bookmarks?.items[0]; assert.ok(retained);
    assert.equal(retained.sourceAvailable, false);
    assert.deepEqual(retained.content, target.content);
    app.controller.callbacks.onJumpToBookmark?.(retained.id);
    assert.equal(app.jumps.length, 0);
    assert.ok(app.chat().notices.some(notice => notice.message.includes("saved bookmark remains")));
    assert.deepEqual(app.storage.readBookmarks(app.owner)[0]?.content, target.content);
    app.controller.callbacks.onRemoveBookmark?.(retained.id);
    assert.deepEqual(app.chat().bookmarks?.items, []);
  } finally { app.controller.stop(); }
});

test("member activity ignores self, duplicate and synchronization events while audio follows both controls", async () => {
  const app = setup();
  try {
    assert.equal(app.plays(), 0);
    const joined = app.member("joined");
    app.controller.receive(joined); await Promise.resolve();
    assert.equal(app.plays(), 1);
    assert.equal(app.chat().activity?.length, 1);
    app.advance(LIMITS.soundCooldownMs + 1);
    app.controller.receive(joined); app.controller.receive(app.member("returned", true));
    assert.equal(app.plays(), 1);
    assert.equal(app.chat().activity?.length, 1);
    app.controller.callbacks.onMemberSoundsChange?.(false);
    app.controller.receive(app.member("left")); await Promise.resolve();
    assert.equal(app.plays(), 1);
    assert.equal(app.chat().activity?.length, 2);
    app.controller.callbacks.onMemberSoundsChange?.(true);
    app.controller.callbacks.onSoundModeChange("off");
    app.controller.receive(app.member("returned")); await Promise.resolve();
    assert.equal(app.plays(), 1);
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.snapshot([]) }));
    assert.equal(app.plays(), 1);
    const activityCount = app.chat().activity?.length;
    app.controller.callbacks.onRetryConnection();
    app.controller.receive(app.member("joined"));
    assert.equal(app.plays(), 1);
    assert.equal(app.chat().activity?.length, activityCount);
  } finally { app.controller.stop(); }
});

test("member events select the entry and departure clips through the application controller", async () => {
  const app = setup();
  try {
    for (const kind of ["joined", "returned", "left"] as const) {
      app.controller.receive(app.member(kind));
      await Promise.resolve();
      app.advance(LIMITS.soundCooldownMs + 1);
    }
    assert.deepEqual(app.heard(), ["/sounds/EnterRoom.wav", "/sounds/EnterRoom.wav", "/sounds/LeaveRoom.wav"]);
  } finally { app.controller.stop(); }
});

test("member records remain in the conversation timeline after a live event", async () => {
  const app = setup();
  try {
    const event = app.member("returned");
    app.controller.receive(event);
    const rows = app.chat().timeline.items.filter(item => item.type === "message");
    const record = rows.find(item => item.type === "message" && item.message.systemEvent === "returned");
    assert.ok(record);
    assert.equal(record.type, "message");
    assert.equal(record.message.content.kind, "text");
    assert.match(record.message.content.text, /returned to the room/);
    assert.equal(record.message.actions.canReact, false);
  } finally { app.controller.stop(); }
});

test("renamed identities explain a returned member without exposing name history", async () => {
  const app = setup();
  try {
    app.controller.receive(app.member("returned", false, randomUUID(), true));
    const record = app.chat().timeline.items.find(item => item.type === "message" && item.message.systemEvent === "returned");
    assert.ok(record && record.type === "message");
    assert.match(record.message.content.kind === "text" ? record.message.content.text : "", /returned under a new display name/);
  } finally { app.controller.stop(); }
});

test("focused member activity remains visible and still plays its dedicated sound", async () => {
  const app = setup({ foreground: true });
  try {
    app.controller.receive(app.member("joined")); await Promise.resolve();
    assert.equal(app.plays(), 1);
    assert.equal(app.chat().activity?.[0]?.kind, "joined");
  } finally { app.controller.stop(); }
});

test("authoritative role replaces cached administrator UI authority before pin actions", () => {
  const app = setup({ role: "admin" });
  try {
    const target = app.message(1, { kind: "text", text: "A public pin" });
    app.ready([target], "guest");
    assert.equal(app.chat().role, "guest");
    assert.equal(app.chat().pinned?.canManage, false);
    app.controller.callbacks.onSetPin?.(target.id);
    assert.equal(app.sent.some(event => event.type === "pin.set"), false);
    app.ready([target], "admin");
    app.controller.callbacks.onSetPin?.(target.id);
    assert.equal(app.sent.filter(event => event.type === "pin.set").length, 1);
  } finally { app.controller.stop(); }
});

test("a pin receipt before its broadcast synchronizes without changing the active draft", () => {
  const app = setup({ role: "admin" });
  try {
    const target = app.message(1, { kind: "text", text: "Pinned context" }); app.ready([target]);
    app.controller.callbacks.onDraftIntent({ type: "text.changed", value: "A draft remains editable" });
    app.controller.callbacks.onSetPin?.(target.id);
    const request = app.sent.find(event => event.type === "pin.set"); assert.equal(request?.type, "pin.set");
    if (request?.type !== "pin.set") throw new Error("Missing pin request");
    assert.equal(app.chat().pinned?.pending, true);
    app.controller.receive(app.envelope("pin.accepted", { operationId: request.payload.operationId, messageId: target.id, appliedRevision: 21, duplicate: false }));
    assert.ok(app.sent.some(event => event.type === "room.sync"));
    assert.equal(app.chat().composer.draft.textBuffer, "A draft remains editable");
    const pin = { message: target, pinnedAt: SAMPLE_NOW, pinnedBy: ALICE };
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.snapshot([target], 21, pin) }));
    assert.equal(app.chat().pinned?.pending, false);
    assert.deepEqual(app.chat().pinned?.message?.content, target.content);
    assert.equal(app.chat().composer.draft.textBuffer, "A draft remains editable");
  } finally { app.controller.stop(); }
});

test("opening bookmarks cancels a future search jump before its synchronization snapshot arrives", async () => {
  const target: ChatMessage = { ...SAMPLE_MESSAGES[0]!, id: randomUUID(), sequence: 1, mutationRevision: 30, content: { kind: "text", text: "ACK future search context" } };
  const response: SearchResponse = { ...SAMPLE_SEARCH, query: "ACK", asOfRevision: 30, results: [{ ...SAMPLE_SEARCH.results[0]!, messageId: target.id, sequence: target.sequence }] };
  const app = setup({ searchResponse: response });
  try {
    app.controller.callbacks.onOpenSearch(); app.controller.callbacks.onSearchQueryChange("ACK");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(app.chat().search.phase, "results");
    app.controller.callbacks.onJumpToMessage(target.id, "search");
    assert.ok(app.sent.some(event => event.type === "room.sync"));
    app.controller.callbacks.onOpenBookmarks?.();
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.snapshot([target], 30) }));
    app.controller.flushLayout();
    assert.equal(app.jumps.length, 0);
    assert.equal(app.chat().bookmarks?.open, true);
    assert.equal(app.chat().search.phase, "closed");
  } finally { app.controller.stop(); }
});

test("selecting retained context supersedes a search jump waiting for synchronization", async () => {
  const future: ChatMessage = { ...SAMPLE_MESSAGES[0]!, id: randomUUID(), sequence: 2, mutationRevision: 30, content: { kind: "text", text: "ACK future context" } };
  const response: SearchResponse = { ...SAMPLE_SEARCH, query: "ACK", asOfRevision: 30, results: [{ ...SAMPLE_SEARCH.results[0]!, messageId: future.id, sequence: future.sequence }] };
  const app = setup({ searchResponse: response });
  try {
    const retained = app.message(1, { kind: "text", text: "Retained reading context" }); app.ready([retained]);
    app.controller.callbacks.onOpenSearch(); app.controller.callbacks.onSearchQueryChange("ACK");
    await new Promise(resolve => setTimeout(resolve, 300));
    app.controller.callbacks.onJumpToMessage(future.id, "search");
    app.controller.callbacks.onJumpToMessage(retained.id, "quote");
    assert.deepEqual(app.jumps.map(value => value.id), [retained.id]);
    app.controller.receive(app.envelope("room.snapshot", { snapshot: app.snapshot([retained, future], 30) }));
    app.controller.flushLayout();
    assert.deepEqual(app.jumps.map(value => value.id), [retained.id]);
  } finally { app.controller.stop(); }
});

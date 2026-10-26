import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserStorage, defaultPreferences, emptyDraft, type StoragePort } from "../client/src/services/storage.js";
import { SoundService, type AudioPort } from "../client/src/services/sound.js";
import type { SessionCredential } from "../shared/http.js";
import type { OutboxEntry } from "../shared/persistence.js";
import { LIMITS } from "../shared/limits.js";

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, string>();
  blocked = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { if (this.blocked) throw new Error("Storage blocked"); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.blocked) throw new Error("Storage blocked"); this.values.set(key, value); }
  removeItem(key: string) { if (this.blocked) throw new Error("Storage blocked"); this.values.delete(key); }
}
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const credential = (n = 1, epoch = 10): SessionCredential => ({ protocolVersion: 1, epochId: id(epoch), roomId: "lobby", self: { id: id(n), displayName: `Guest ${n}`, avatarSeed: String(n) }, bearerToken: n.toString(16).padStart(64, "0"), expiresAt: 100_000 });
const entry = (owner: SessionCredential, n = 20): OutboxEntry => ({ operationId: id(n), epochId: owner.epochId, ownerUserId: owner.self.id, localCreatedAt: 1000 + n,
  input: { operationId: id(n), roomId: "lobby", content: { kind: "text", text: "A message" }, replyToId: null }, delivery: { phase: "sending" } });
const ports = () => ({ sessionStorage: new MemoryStorage(), localStorage: new MemoryStorage(), now: () => 1000 });

test("session credentials are tab-scoped, validated and expired records are removed", () => {
  const options = ports(), store = new BrowserStorage("http://localhost:3000", options), session = credential();
  assert.equal(store.writeSession(session), true);
  assert.deepEqual(store.readSession(), session);
  assert.equal(options.localStorage.length, 0);
  const otherTab = new BrowserStorage("http://localhost:3000", { ...ports(), localStorage: options.localStorage });
  assert.equal(otherTab.readSession(), null);
  const expired = new BrowserStorage("http://localhost:3000", { ...options, now: () => 100_001 });
  assert.equal(expired.readSession(), null);
  assert.equal(options.sessionStorage.length, 0);
});
test("drafts keep both buffers and are partitioned by backend, identity and epoch", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential();
  const draft = { ...emptyDraft(), revision: 7, textBuffer: "Next message", codeBuffer: { source: "\tconst x = '**literal**';\n", language: "typescript" as const }, replyTarget: { epochId: session.epochId, messageId: id(40) } };
  assert.equal(store.writeDraft(session, draft), true);
  assert.deepEqual(store.readDraft(session), draft);
  assert.equal(store.readDraft(credential(2)), null);
  assert.equal(store.readDraft(credential(1, 11)), null);
  assert.equal(new BrowserStorage("https://other.example", options).readDraft(session), null);
});
test("outbox restores uncertain delivery without changing operation identity or resending", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential(), pending = entry(session);
  assert.equal(store.writeOutbox(session, [pending]), true);
  const restored = new BrowserStorage("https://chat.example", options).readOutbox(session);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.operationId, pending.operationId);
  assert.deepEqual(restored[0]?.delivery, { phase: "unknown", canRetry: true, reason: "disconnected" });
  assert.deepEqual(store.readOutbox(credential(1, 11)), []);
  assert.equal(store.writeOutbox(session, Array.from({ length: LIMITS.pendingMessages + 1 }, (_, n) => entry(session, 20 + n))), false);
});
test("corrupted and cross-owner persisted records are rejected", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential();
  store.writeOutbox(session, [entry(session)]);
  const key = [...options.sessionStorage.values.keys()].find(value => value.endsWith(":outbox"))!;
  const record = JSON.parse(options.sessionStorage.getItem(key)!);
  record.entries[0].ownerUserId = credential(2).self.id;
  options.sessionStorage.setItem(key, JSON.stringify(record));
  assert.deepEqual(store.readOutbox(session), []);
  assert.equal(options.sessionStorage.getItem(key), null);
  store.writeDraft(session, emptyDraft());
  const composer = [...options.sessionStorage.values.keys()].find(value => value.endsWith(":composer"))!;
  options.sessionStorage.setItem(composer, "{invalid");
  assert.equal(store.readDraft(session), null);
  assert.equal(options.sessionStorage.getItem(composer), null);
});
test("unavailable storage degrades to isolated memory without throwing", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential();
  options.sessionStorage.blocked = true;
  assert.equal(store.writeSession(session), false);
  assert.equal(store.available(), false);
  assert.deepEqual(store.readSession(), session);
  assert.equal(store.writeDraft(session, { ...emptyDraft(), textBuffer: "Still editable" }), false);
  assert.equal(store.readDraft(session)?.textBuffer, "Still editable");
  assert.equal(store.available("local"), true);
});
test("preferences are shared through local storage and invalid values fall back safely", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options);
  const preferences = { ...defaultPreferences(), soundMode: "incoming" as const, textSendShortcut: "mod-enter" as const, shareTyping: false };
  assert.equal(store.writePreferences(preferences), true);
  assert.deepEqual(new BrowserStorage("https://chat.example", options).readPreferences(), preferences);
  const key = [...options.localStorage.values.keys()][0]!;
  options.localStorage.setItem(key, JSON.stringify({ ...preferences, shareTyping: "yes" }));
  assert.deepEqual(store.readPreferences(), defaultPreferences());
});
test("stored state retains a bounded number of identities without evicting active outbox", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options);
  for (let n = 1; n <= 6; n++) {
    const session = credential(n);
    store.writeSession(session); store.writeOutbox(session, [entry(session, 30 + n)]); store.writeDraft(session, { ...emptyDraft(), textBuffer: `Text ${n}` });
  }
  assert.equal([...options.sessionStorage.values.keys()].filter(key => key.includes(":state:")).length, 4);
  assert.equal(store.readOutbox(credential(6)).length, 1);
  assert.equal(store.readDraft(credential(6))?.textBuffer, "Text 6");
  assert.equal(store.readDraft(credential(1)), null);
});

class AudioStub implements AudioPort {
  currentTime = 0;
  preload = "";
  plays = 0;
  pauses = 0;
  playResult: () => Promise<void> = () => Promise.resolve();
  play() { this.plays++; return this.playResult(); }
  pause() { this.pauses++; }
}
test("audio starts in the gesture callback, reports readiness and enforces cooldown", async () => {
  const audio = new AudioStub(); let at = 1000, notifications = 0;
  const service = new SoundService({ createAudio: source => { assert.equal(source, "/sounds/NewMsg.wav"); return audio; }, now: () => at, onChange: () => notifications++ });
  assert.deepEqual(service.view(), { mode: "off", playback: "not-enabled" });
  service.receive(); assert.equal(audio.plays, 0);
  const enabling = service.setMode("incoming"); assert.equal(audio.plays, 1);
  await enabling; assert.equal(service.view().playback, "ready"); assert.equal(notifications, 1);
  service.receive(); service.receive(); assert.equal(audio.plays, 2);
  await Promise.resolve();
  at += LIMITS.soundCooldownMs; service.receive(); assert.equal(audio.plays, 3);
  await service.setMode("off"); service.receive(); await service.preview(); assert.equal(audio.plays, 3);
  assert.equal(service.view().playback, "not-enabled");
});
test("audio permission denial and missing support are honest presentation states", async () => {
  const audio = new AudioStub(); audio.playResult = () => Promise.reject(Object.assign(new Error("Denied"), { name: "NotAllowedError" }));
  const blocked = new SoundService({ createAudio: () => audio }); await blocked.setMode("incoming");
  assert.equal(blocked.view().playback, "blocked"); blocked.receive(); assert.equal(audio.plays, 2);
  audio.playResult = () => Promise.resolve(); await blocked.preview(); assert.equal(blocked.view().playback, "ready");
  const missing = new SoundService({ createAudio: () => { throw new Error("Unavailable"); } }); await missing.setMode("incoming");
  assert.equal(missing.view().playback, "unavailable");
});
test("late play completion cannot re-enable muted audio and dispose permits a fresh gesture", async () => {
  const audio = new AudioStub(); let finish: () => void = () => {};
  audio.playResult = () => new Promise<void>(resolve => { finish = resolve; });
  const service = new SoundService({ createAudio: () => audio });
  const enabling = service.setMode("incoming"); await service.setMode("off"); finish(); await enabling;
  assert.equal(service.view().playback, "not-enabled");
  service.dispose(); audio.playResult = () => Promise.resolve(); await service.setMode("incoming");
  assert.equal(service.view().playback, "ready"); service.dispose(); assert.deepEqual(service.view(), { mode: "off", playback: "not-enabled" });
});
test("restored incoming sound waits silently and attempts the first real notification without toggling", async () => {
  const audio = new AudioStub(); let created = 0;
  const service = new SoundService({ createAudio: () => { created++; return audio; } });
  service.restore("incoming");
  assert.deepEqual(service.view(), { mode: "incoming", playback: "unverified" });
  assert.equal(created, 0); assert.equal(audio.plays, 0);
  service.receive(); assert.equal(audio.plays, 1);
  await Promise.resolve(); assert.equal(service.view().playback, "ready");
  service.dispose(); service.restore("incoming");
  assert.equal(audio.plays, 1); service.receive(); assert.equal(audio.plays, 2);
  await Promise.resolve(); assert.equal(service.view().playback, "ready");
  service.dispose();
});
test("blocked incoming playback retries immediately after permission changes without changing the saved mode", async () => {
  const audio = new AudioStub(); let allowed = false;
  audio.playResult = () => allowed ? Promise.resolve() : Promise.reject(Object.assign(new Error("Denied"), { name: "NotAllowedError" }));
  const service = new SoundService({ createAudio: () => audio, now: () => 1000 });
  service.restore("incoming"); service.receive(); service.receive(); assert.equal(audio.plays, 1);
  await Promise.resolve();
  assert.deepEqual(service.view(), { mode: "incoming", playback: "blocked" });
  allowed = true;
  service.receive(); assert.equal(audio.plays, 2); await Promise.resolve();
  assert.deepEqual(service.view(), { mode: "incoming", playback: "ready" });
  service.dispose();
});
test("restored mute never plays and a pending notification prevents overlapping attempts", async () => {
  const audio = new AudioStub(); let finish: () => void = () => {}, at = 1000;
  audio.playResult = () => new Promise(resolve => { finish = resolve; });
  const service = new SoundService({ createAudio: () => audio, now: () => at });
  service.restore("off"); service.receive(); await service.preview(); assert.equal(audio.plays, 0);
  service.restore("incoming"); service.receive(); at += LIMITS.soundCooldownMs;
  service.receive(); assert.equal(audio.plays, 1);
  service.restore("off"); finish(); await Promise.resolve();
  assert.deepEqual(service.view(), { mode: "off", playback: "not-enabled" });
  service.dispose();
});
test("an older play completion cannot overwrite the outcome of a newer preview", async () => {
  const audio = new AudioStub(); let finish: () => void = () => {};
  audio.playResult = () => new Promise(resolve => { finish = resolve; });
  const service = new SoundService({ createAudio: () => audio }); service.restore("incoming");
  const first = service.preview();
  audio.playResult = () => Promise.reject(Object.assign(new Error("Denied"), { name: "NotAllowedError" }));
  await service.preview(); assert.equal(service.view().playback, "blocked");
  finish(); await first; assert.equal(service.view().playback, "blocked");
  service.dispose();
});
test("joins and returns share the entry clip while departures and messages use their own clips", async () => {
  let at = 1000;
  const heard: string[] = [];
  const service = new SoundService({ now: () => at, createAudio: source => ({
    currentTime: 0, pause: () => {}, play: async () => { heard.push(source); },
  }) });
  service.restore("incoming");
  assert.deepEqual(heard, []);
  for (const kind of ["joined", "returned", "left", "message"] as const) {
    service.receive(kind);
    await Promise.resolve();
    at += LIMITS.soundCooldownMs;
  }
  assert.deepEqual(heard, ["/sounds/EnterRoom.wav", "/sounds/EnterRoom.wav", "/sounds/LeaveRoom.wav", "/sounds/NewMsg.wav"]);
  await service.preview();
  assert.equal(heard.at(-1), "/sounds/NewMsg.wav");
  service.dispose();
});
test("muting or pending playback prevents another member clip from starting", async () => {
  const heard: string[] = [];
  let finish: () => void = () => {};
  const service = new SoundService({ createAudio: source => ({ currentTime: 0, pause: () => {},
    play: () => { heard.push(source); return new Promise<void>(resolve => { finish = resolve; }); },
  }) });
  service.restore("off");
  service.receive("joined"); service.receive("returned"); service.receive("left");
  assert.deepEqual(heard, []);
  service.restore("incoming");
  service.receive("joined"); service.receive("left");
  assert.deepEqual(heard, ["/sounds/EnterRoom.wav"]);
  await service.setMode("off");
  finish(); await Promise.resolve();
  service.receive("left");
  assert.deepEqual(service.view(), { mode: "off", playback: "not-enabled" });
  assert.deepEqual(heard, ["/sounds/EnterRoom.wav"]);
  service.dispose();
});
test("failure of one member clip does not disable other notification clips", async () => {
  const heard: string[] = [];
  const service = new SoundService({ createAudio: source => {
    if (source.endsWith("LeaveRoom.wav")) throw new Error("Audio unavailable");
    return { currentTime: 0, pause: () => {}, play: async () => { heard.push(source); } };
  } });
  service.restore("incoming"); service.receive("left");
  await Promise.resolve();
  assert.equal(service.view().playback, "unavailable");
  service.receive("joined"); await Promise.resolve();
  assert.deepEqual(heard, ["/sounds/EnterRoom.wav"]);
  assert.equal(service.view().playback, "ready");
  await service.preview();
  assert.deepEqual(heard, ["/sounds/EnterRoom.wav", "/sounds/NewMsg.wav"]);
  service.dispose();
});
test("readable storage survives write denial and unsaved edits retain precedence", () => {
  class ReadOnlyStorage extends MemoryStorage {
    readOnly = false;
    override setItem(key: string, value: string) { if (this.readOnly) throw new Error("Quota exceeded"); super.setItem(key, value); }
  }
  const sessionStorage = new ReadOnlyStorage(), options = { sessionStorage, localStorage: new MemoryStorage(), now: () => 1000 };
  const first = new BrowserStorage("https://chat.example", options), session = credential();
  first.writeSession(session); first.writeDraft(session, { ...emptyDraft(), textBuffer: "Saved text" });
  sessionStorage.readOnly = true;
  const resumed = new BrowserStorage("https://chat.example", options);
  assert.equal(resumed.available(), false);
  assert.deepEqual(resumed.readSession(), session);
  assert.equal(resumed.readDraft(session)?.textBuffer, "Saved text");
  assert.equal(resumed.writeDraft(session, { ...emptyDraft(), textBuffer: "Current text" }), false);
  assert.equal(resumed.readDraft(session)?.textBuffer, "Current text");
});

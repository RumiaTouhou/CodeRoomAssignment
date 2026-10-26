import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserStorage, defaultPreferences, type StoragePort } from "../client/src/services/storage.js";
import type { SessionCredential } from "../shared/http.js";
import type { StoredBookmark } from "../shared/persistence.js";
import { LIMITS } from "../shared/limits.js";

class StorageMemory implements StoragePort {
  readonly values = new Map<string, string>();
  denied = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.denied) throw new Error("Quota exceeded"); this.values.set(key, value); }
  removeItem(key: string) { if (this.denied) throw new Error("Read only"); this.values.delete(key); }
}
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const credential = (owner = 1, epoch = 200): SessionCredential => ({ protocolVersion: 1, roomId: "lobby", epochId: id(epoch), self: { id: id(owner), displayName: `Guest ${owner}`, avatarSeed: String(owner) }, bearerToken: "a".repeat(64), identityToken: "b".repeat(64), role: "guest", expiresAt: 100_000 });
const bookmark = (value = 1): StoredBookmark => ({ id: id(1_000 + value), epochId: id(200), messageId: id(2_000 + value), author: credential(2).self, createdAt: 100 + value, savedAt: 1_000 + value, content: { kind: "code", source: "\tconst literal = '**code**';\n\n", language: "typescript" } });
const ports = () => ({ sessionStorage: new StorageMemory(), localStorage: new StorageMemory(), now: () => 1_000 });

test("identity recovery saves only its own secret and remains isolated from session authority", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example/", options), session = { ...credential(), role: "admin" as const };
  assert.equal(store.writeSession(session), true);
  assert.equal(options.localStorage.length, 0);
  assert.equal(store.writeRestoreCredential(session.identityToken!), true);
  const local = [...options.localStorage.values.values()].join("");
  assert.equal(local.includes(session.bearerToken), false);
  assert.equal(local.includes("admin"), false);
  assert.equal(local.includes("114514"), false);
  const otherTab = new BrowserStorage("https://chat.example", { ...options, sessionStorage: new StorageMemory() });
  assert.equal(otherTab.readSession(), null);
  assert.equal(otherTab.readRestoreCredential(), session.identityToken);
  assert.equal(new BrowserStorage("https://other.example", options).readRestoreCredential(), null);
  assert.equal(store.writeRestoreCredential("invalid"), false);
  assert.equal(store.readRestoreCredential(), session.identityToken);
  store.clearRestoreCredential();
  assert.equal(store.readRestoreCredential(), null);
  assert.deepEqual(store.readSession(), session);
});

test("malformed identity records are removed rather than used for recovery", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options);
  store.writeRestoreCredential("b".repeat(64));
  const key = [...options.localStorage.values.keys()][0]!;
  options.localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, apiOrigin: "https://other.example", identityToken: "b".repeat(64) }));
  assert.equal(store.readRestoreCredential(), null);
  assert.equal(options.localStorage.getItem(key), null);
});

test("bookmarks retain original code snapshots across epochs and isolate backend and owner", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential(), saved = bookmark();
  assert.equal(store.writeBookmarks(session, [saved]), true);
  assert.deepEqual(new BrowserStorage("https://chat.example", options).readBookmarks(credential(1, 201)), [saved]);
  assert.deepEqual(store.readBookmarks(credential(2)), []);
  assert.deepEqual(new BrowserStorage("https://other.example", options).readBookmarks(session), []);
  assert.equal(options.sessionStorage.length, 0);
  assert.equal(store.removeBookmark(session, saved.id), true);
  assert.deepEqual(store.readBookmarks(session), []);
  store.writeBookmarks(session, [saved]);
  store.clearBookmarks(session);
  assert.deepEqual(store.readBookmarks(session), []);
});

test("bookmark count, bytes, duplicate sources and content validation protect existing saves", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential(), saved = bookmark();
  const hundred = Array.from({ length: 100 }, (_, index) => bookmark(index));
  assert.equal(store.writeBookmarks(session, hundred), true);
  assert.equal(store.writeBookmarks(session, [...hundred, bookmark(100)]), false);
  assert.deepEqual(store.readBookmarks(session), hundred);
  assert.equal(store.writeBookmarks(session, [saved, { ...saved, id: id(9_000) }]), false);
  assert.equal(store.writeBookmarks(session, [saved, { ...bookmark(2), id: saved.id }]), false);
  assert.equal(store.writeBookmarks(session, [{ ...saved, content: { kind: "text", text: "bad\u0000body" } }]), false);
  assert.equal(store.writeBookmarks(session, [{ ...saved, content: { kind: "code", source: "x".repeat(LIMITS.messageBodyUtf8Bytes + 1), language: "plaintext" } }]), false);
  const full = Array.from({ length: 100 }, (_, index) => ({ ...bookmark(index), content: { kind: "text" as const, text: "x".repeat(LIMITS.messageBodyUtf8Bytes) } }));
  assert.equal(store.writeBookmarks(session, full), false);
  assert.deepEqual(store.readBookmarks(session), hundred);
});

test("corrupt or cross-owner bookmark records are discarded", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential();
  store.writeBookmarks(session, [bookmark()]);
  const key = [...options.localStorage.values.keys()].find(value => value.endsWith(":bookmarks"))!;
  const record = JSON.parse(options.localStorage.getItem(key)!);
  record.ownerUserId = credential(2).self.id;
  options.localStorage.setItem(key, JSON.stringify(record));
  assert.deepEqual(store.readBookmarks(session), []);
  assert.equal(options.localStorage.getItem(key), null);
  store.writeBookmarks(session, [bookmark()]);
  const malformed = JSON.parse(options.localStorage.getItem(key)!);
  malformed.entries[0].author.password = "secret";
  options.localStorage.setItem(key, JSON.stringify(malformed));
  assert.deepEqual(store.readBookmarks(session), []);
});

test("legacy preferences migrate once to the active stable identity with reading defaults", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential();
  const key = `coderoom:${encodeURIComponent("https://chat.example")}:preferences`;
  options.localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, soundMode: "incoming", textSendShortcut: "mod-enter", shareTyping: false }));
  const expected = { ...defaultPreferences(), soundMode: "incoming" as const, textSendShortcut: "mod-enter" as const, shareTyping: false };
  assert.deepEqual(store.readPreferences(session), expected);
  assert.equal(options.localStorage.getItem(key), null);
  assert.deepEqual(store.readPreferences(credential(1, 201)), expected);
  assert.deepEqual(store.readPreferences(credential(2)), defaultPreferences());
  assert.deepEqual(store.readPreferences(), defaultPreferences());
  const reading = { ...expected, readingSize: "larger" as const, memberSounds: false };
  assert.equal(store.writePreferences(reading, session), true);
  assert.deepEqual(new BrowserStorage("https://chat.example", options).readPreferences(session), reading);
  assert.deepEqual(new BrowserStorage("https://other.example", options).readPreferences(session), defaultPreferences());
});

test("invalid scoped preferences fall back without borrowing another identity settings", () => {
  const options = ports(), store = new BrowserStorage("https://chat.example", options), session = credential();
  store.writePreferences({ ...defaultPreferences(), readingSize: "large" }, session);
  const key = [...options.localStorage.values.keys()].find(value => value.endsWith(":preferences"))!;
  const record = JSON.parse(options.localStorage.getItem(key)!);
  record.preferences.readingSize = "huge";
  options.localStorage.setItem(key, JSON.stringify(record));
  assert.deepEqual(store.readPreferences(session), defaultPreferences());
  assert.equal(options.localStorage.getItem(key), null);
});

test("quota denial keeps readable saved local state and current memory edits", () => {
  const options = ports(), session = credential(), saved = bookmark(), initial = new BrowserStorage("https://chat.example", options);
  initial.writeBookmarks(session, [saved]);
  initial.writeRestoreCredential(session.identityToken!);
  initial.writePreferences({ ...defaultPreferences(), readingSize: "large" }, session);
  options.localStorage.denied = true;
  const store = new BrowserStorage("https://chat.example", options);
  assert.equal(store.available("local"), false);
  assert.deepEqual(store.readBookmarks(session), [saved]);
  assert.equal(store.readRestoreCredential(), session.identityToken);
  assert.equal(store.readPreferences(session).readingSize, "large");
  assert.equal(store.writeBookmarks(session, [saved, bookmark(2)]), false);
  assert.equal(store.readBookmarks(session).length, 2);
  assert.equal(store.writePreferences({ ...defaultPreferences(), readingSize: "larger" }, session), false);
  assert.equal(store.readPreferences(session).readingSize, "larger");
  store.clearBookmarks(session);
  store.clearRestoreCredential();
  assert.deepEqual(store.readBookmarks(session), []);
  assert.equal(store.readRestoreCredential(), null);
});

test("local identity records are bounded while retaining the active identity saves", () => {
  const options = ports(); let at = 1_000;
  const store = new BrowserStorage("https://chat.example", { ...options, now: () => at++ });
  for (let owner = 1; owner <= 25; owner++) {
    store.writeBookmarks(credential(owner), [bookmark(owner)]);
    store.writePreferences(defaultPreferences(), credential(owner));
  }
  assert.equal([...options.localStorage.values.keys()].filter(key => key.includes(":identity:")).length, 40);
  assert.deepEqual(store.readBookmarks(credential(25)), [bookmark(25)]);
  assert.deepEqual(store.readBookmarks(credential(1)), []);
});

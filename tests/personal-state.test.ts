import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BrowserStorage, defaultPreferences, type StoragePort } from "../client/src/services/storage.js";
import type { SessionCredential } from "../shared/http.js";
import type { StoredBookmark } from "../shared/persistence.js";
import { LIMITS } from "../shared/limits.js";

class BrowserValues implements StoragePort {
  readonly values = new Map<string, string>();
  blocked = false;
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { if (this.blocked) throw new Error("Storage unavailable"); return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.blocked) throw new Error("Storage unavailable"); this.values.set(key, value); }
  removeItem(key: string): void { if (this.blocked) throw new Error("Storage unavailable"); this.values.delete(key); }
}

const origin = "https://room.example";
const prefix = `coderoom:${encodeURIComponent(origin)}:`;
const credential = (): SessionCredential => ({ protocolVersion: 1, epochId: randomUUID(), roomId: "lobby", self: { id: randomUUID(), displayName: "Alice", avatarSeed: "alice" }, bearerToken: "a".repeat(64), identityToken: "b".repeat(64), role: "admin", expiresAt: 10_000 });
const ports = () => ({ sessionStorage: new BrowserValues(), localStorage: new BrowserValues(), now: () => 1000 });
function bookmark(owner: SessionCredential, source = '\tconst message = "<p>literal</p> 😀";\n'): StoredBookmark {
  return { id: randomUUID(), epochId: owner.epochId, messageId: randomUUID(), author: owner.self, createdAt: 400, savedAt: 900, content: { kind: "code", language: "typescript", source } };
}

test("earlier preferences migrate without changing sound, shortcut or typing choices", () => {
  const options = ports(), owner = credential();
  const earlier = { schemaVersion: 1, soundMode: "incoming", textSendShortcut: "mod-enter", shareTyping: false };
  options.localStorage.setItem(`${prefix}preferences`, JSON.stringify(earlier));
  const storage = new BrowserStorage(origin, options);
  assert.deepEqual(storage.readPreferences(owner), { ...earlier, readingSize: "standard", memberSounds: true });
  assert.equal(options.localStorage.getItem(`${prefix}preferences`), null);
  assert.deepEqual(new BrowserStorage(origin, options).readPreferences(owner), { ...earlier, readingSize: "standard", memberSounds: true });
  assert.deepEqual(storage.readPreferences(credential()), defaultPreferences());
});

test("reading preferences retain partial migration choices and remain scoped to backend and guest", () => {
  const options = ports(), owner = credential();
  options.localStorage.setItem(`${prefix}preferences`, JSON.stringify({ schemaVersion: 1, soundMode: "off", textSendShortcut: "mod-enter", shareTyping: true, memberSounds: false }));
  const storage = new BrowserStorage(origin, options);
  assert.deepEqual(storage.readPreferences(owner), { schemaVersion: 1, soundMode: "off", textSendShortcut: "mod-enter", shareTyping: true, readingSize: "standard", memberSounds: false });
  const selected = { ...storage.readPreferences(owner), readingSize: "larger" as const };
  assert.equal(storage.writePreferences(selected, owner), true);
  assert.deepEqual(new BrowserStorage(origin, options).readPreferences(owner), selected);
  assert.deepEqual(new BrowserStorage("https://other.example", options).readPreferences(owner), defaultPreferences());
  assert.deepEqual(storage.readPreferences(credential()), defaultPreferences());
  assert.equal(storage.writePreferences({ ...selected, readingSize: "unsupported" } as never, owner), false);
  assert.deepEqual(storage.readPreferences(owner), selected);
});

test("identity restoration is stored separately from bearer authorization and session expiry", () => {
  const options = ports(), owner = credential(), storage = new BrowserStorage(origin, options);
  assert.ok(owner.identityToken);
  assert.equal(storage.writeRestoreCredential(owner.identityToken), true);
  assert.equal(storage.writeSession(owner), true);
  const otherTab = new BrowserStorage(origin, { ...options, sessionStorage: new BrowserValues() });
  assert.equal(otherTab.readSession(), null);
  assert.equal(otherTab.readRestoreCredential(), owner.identityToken);
  assert.equal(options.localStorage.values.size, 1);
  const record = JSON.parse([...options.localStorage.values.values()][0]!);
  assert.deepEqual(Object.keys(record).sort(), ["apiOrigin", "identityToken", "schemaVersion"]);
  assert.ok(!JSON.stringify(record).includes(owner.bearerToken));
  assert.ok(!Object.hasOwn(record, "role"));
  const expired = new BrowserStorage(origin, { ...options, now: () => 10_001 });
  assert.equal(expired.readSession(), null);
  assert.equal(expired.readRestoreCredential(), owner.identityToken);
  assert.equal(storage.writeRestoreCredential("invalid"), false);
  storage.clearSession();
  assert.equal(storage.readRestoreCredential(), owner.identityToken);
  assert.equal(new BrowserStorage("https://other.example", options).readRestoreCredential(), null);
});

test("bookmark snapshots preserve full raw content across reload and room epochs without crossing identities", () => {
  const options = ports(), owner = credential(), storage = new BrowserStorage(origin, options);
  const saved = bookmark(owner);
  assert.equal(storage.writeBookmarks(owner, [saved]), true);
  const reloaded = new BrowserStorage(origin, { ...options, sessionStorage: new BrowserValues() });
  assert.deepEqual(reloaded.readBookmarks(owner), [saved]);
  assert.deepEqual(reloaded.readBookmarks({ ...owner, epochId: randomUUID() }), [saved]);
  assert.deepEqual(reloaded.readBookmarks(credential()), []);
  assert.deepEqual(new BrowserStorage("https://other.example", options).readBookmarks(owner), []);
  const content = reloaded.readBookmarks(owner)[0]?.content;
  assert.equal(content?.kind === "code" ? content.source : null, saved.content.kind === "code" ? saved.content.source : null);
  assert.equal(storage.removeBookmark(owner, saved.id), true);
  assert.deepEqual(storage.readBookmarks(owner), []);
});

test("bookmark count, duplicate identities and serialized size limits preserve the prior collection", () => {
  const options = ports(), owner = credential(), storage = new BrowserStorage(origin, options);
  const collection = Array.from({ length: 100 }, () => bookmark(owner));
  assert.equal(storage.writeBookmarks(owner, collection), true);
  assert.equal(storage.writeBookmarks(owner, [...collection, bookmark(owner)]), false);
  assert.deepEqual(storage.readBookmarks(owner), collection);
  assert.equal(storage.writeBookmarks(owner, [collection[0]!, { ...collection[1]!, id: collection[0]!.id }]), false);
  assert.equal(storage.writeBookmarks(owner, [collection[0]!, { ...collection[1]!, messageId: collection[0]!.messageId }]), false);
  const large = Array.from({ length: 70 }, () => bookmark(owner, "😀".repeat(LIMITS.messageBodyUtf8Bytes / 4)));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > LIMITS.historyJsonUtf8Bytes);
  assert.equal(storage.writeBookmarks(owner, large), false);
  assert.deepEqual(storage.readBookmarks(owner), collection);
  storage.clearBookmarks(owner);
  assert.deepEqual(new BrowserStorage(origin, options).readBookmarks(owner), []);
});

test("corrupted bookmark ownership and unsafe snapshots are rejected before rendering", () => {
  const options = ports(), owner = credential(), storage = new BrowserStorage(origin, options);
  const saved = bookmark(owner);
  assert.equal(storage.writeBookmarks(owner, [saved]), true);
  const key = [...options.localStorage.values.keys()].find(value => value.endsWith(":bookmarks"))!;
  const record = JSON.parse(options.localStorage.getItem(key)!);
  record.ownerUserId = randomUUID();
  options.localStorage.setItem(key, JSON.stringify(record));
  assert.deepEqual(storage.readBookmarks(owner), []);
  assert.equal(options.localStorage.getItem(key), null);
  assert.equal(storage.writeBookmarks(owner, [{ ...saved, content: { kind: "text", text: "unsafe\0control" } }]), false);
  assert.equal(storage.writeBookmarks(owner, [{ ...saved, content: { kind: "code", language: "unknown", source: "literal" } }] as never), false);
  assert.equal(storage.writeBookmarks(owner, [{ ...saved, createdAt: Number.NaN }]), false);
});

test("bookmark and reading changes remain usable in memory when persistent storage fails", () => {
  const options = ports(), owner = credential(), storage = new BrowserStorage(origin, options), saved = bookmark(owner);
  options.localStorage.blocked = true;
  assert.equal(storage.writeBookmarks(owner, [saved]), false);
  assert.deepEqual(storage.readBookmarks(owner), [saved]);
  const preferences = { ...defaultPreferences(), readingSize: "large" as const, memberSounds: false };
  assert.equal(storage.writePreferences(preferences, owner), false);
  assert.deepEqual(storage.readPreferences(owner), preferences);
  assert.equal(storage.available("local"), false);
});

import type { SessionCredential } from "../../../shared/http.js";
import type { OutboxEntry, StoredBookmark, StoredDraft, StoredOutbox, StoredSession } from "../../../shared/persistence.js";
import type { ComposerDraft, DeliveryView, LocalPreferences } from "../../../shared/ui.js";
import { CODE_LANGUAGES, LIMITS } from "../../../shared/limits.js";
import { parseClientEvent, parseServerEvent, parseSessionCredential, utf8Bytes } from "../../../shared/validation.js";

export interface StoragePort {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface StorageOptions {
  readonly sessionStorage?: StoragePort | null;
  readonly localStorage?: StoragePort | null;
  readonly now?: () => number;
}
type StorageKind = "session" | "local";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxBodyBytes = LIMITS.historyJsonUtf8Bytes;
const maxRecordBytes = maxBodyBytes * 2 + LIMITS.clientFrameUtf8Bytes;
const maxStateGroups = 2;
const maxLocalIdentityGroups = 20;
const maxBookmarks = 100;
const token = /^[0-9a-f]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const text = (value: unknown): value is string => typeof value === "string" && utf8Bytes(value) <= maxBodyBytes;
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

export const defaultPreferences = (): LocalPreferences => ({ schemaVersion: 1, soundMode: "off", textSendShortcut: "enter", shareTyping: true, readingSize: "standard", memberSounds: true });
export const emptyDraft = (): ComposerDraft => ({ schemaVersion: 1, revision: 0, mode: "text", textBuffer: "", codeBuffer: { source: "", language: "plaintext" }, replyTarget: null });

function readBrowserStorage(kind: StorageKind): StoragePort | null {
  try { return typeof window === "undefined" ? null : kind === "session" ? window.sessionStorage : window.localStorage; }
  catch { return null; }
}
function validPreferences(value: unknown): value is LocalPreferences {
  return isObject(value) && keys(value, ["schemaVersion", "soundMode", "textSendShortcut", "shareTyping", "readingSize", "memberSounds"]) && validPreferenceFields(value)
    && (value.readingSize === "standard" || value.readingSize === "large" || value.readingSize === "larger") && typeof value.memberSounds === "boolean";
}
function validPreferenceFields(value: Record<string, unknown>): boolean {
  return value.schemaVersion === 1 && (value.soundMode === "off" || value.soundMode === "incoming")
    && (value.textSendShortcut === "enter" || value.textSendShortcut === "mod-enter") && typeof value.shareTyping === "boolean";
}
function migratePreferences(value: unknown): LocalPreferences | null {
  if (validPreferences(value)) return value;
  if (!isObject(value) || Object.keys(value).some(key => !["schemaVersion", "soundMode", "textSendShortcut", "shareTyping", "readingSize", "memberSounds"].includes(key)) || !validPreferenceFields(value)
    || (value.readingSize !== undefined && !["standard", "large", "larger"].includes(String(value.readingSize))) || (value.memberSounds !== undefined && typeof value.memberSounds !== "boolean")) return null;
  return { ...defaultPreferences(), soundMode: value.soundMode as LocalPreferences["soundMode"], textSendShortcut: value.textSendShortcut as LocalPreferences["textSendShortcut"], shareTyping: value.shareTyping as boolean,
    readingSize: (value.readingSize ?? "standard") as NonNullable<LocalPreferences["readingSize"]>, memberSounds: (value.memberSounds ?? true) as boolean };
}
function validBookmark(value: unknown): value is StoredBookmark {
  if (!isObject(value) || !keys(value, ["id", "epochId", "messageId", "author", "createdAt", "savedAt", "content"])
    || !identifier(value.id) || !identifier(value.epochId) || !identifier(value.messageId) || !integer(value.createdAt) || !integer(value.savedAt)
    || !isObject(value.author) || !isObject(value.content)) return false;
  const author = value.author;
  if (!keys(author, ["id", "displayName", "avatarSeed"]) || !identifier(author.id) || typeof author.displayName !== "string"
    || Array.from(author.displayName).length < 1 || Array.from(author.displayName).length > LIMITS.nicknameCodePoints
    || typeof author.avatarSeed !== "string" || Array.from(author.avatarSeed).length < 1 || Array.from(author.avatarSeed).length > 64) return false;
  const content = value.content;
  const validBody = (body: unknown): body is string => typeof body === "string" && body.trim().length > 0 && utf8Bytes(body) <= LIMITS.messageBodyUtf8Bytes && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(body);
  if (content.kind === "text") return keys(content, ["kind", "text"]) && validBody(content.text);
  return content.kind === "code" && keys(content, ["kind", "source", "language"]) && validBody(content.source) && CODE_LANGUAGES.includes(content.language as typeof CODE_LANGUAGES[number]);
}
function validDraft(value: unknown, credential: SessionCredential): value is ComposerDraft {
  if (!isObject(value) || !keys(value, ["schemaVersion", "revision", "mode", "textBuffer", "codeBuffer", "replyTarget"]) || value.schemaVersion !== 1 || !integer(value.revision)
    || (value.mode !== "text" && value.mode !== "code") || !text(value.textBuffer) || !isObject(value.codeBuffer)
    || !keys(value.codeBuffer, ["source", "language"]) || !text(value.codeBuffer.source) || !CODE_LANGUAGES.includes(value.codeBuffer.language as typeof CODE_LANGUAGES[number])) return false;
  return value.replyTarget === null || (isObject(value.replyTarget) && keys(value.replyTarget, ["epochId", "messageId"])
    && value.replyTarget.epochId === credential.epochId && identifier(value.replyTarget.messageId));
}
function validDelivery(value: unknown, operationId: string, epochId: string): value is OutboxEntry["delivery"] {
  if (!isObject(value)) return false;
  if (value.phase === "sending" || value.phase === "accepted-outside-history") return keys(value, ["phase"]);
  if (value.phase === "unknown") return keys(value, ["phase", "canRetry", "reason"]) && typeof value.canRetry === "boolean" && ["timeout", "disconnected", "server-error", "session-lost"].includes(String(value.reason));
  if (value.phase !== "rejected" || !keys(value, ["phase", "error"])) return false;
  return parseServerEvent({ v: 1, type: "request.error", epochId, serverTime: 0, payload: { requestId: operationId, operationId, error: value.error } }).ok;
}
function validEntry(value: unknown, credential: SessionCredential): value is OutboxEntry {
  if (!isObject(value) || !keys(value, ["operationId", "epochId", "ownerUserId", "localCreatedAt", "input", "delivery"]) || !identifier(value.operationId)
    || value.epochId !== credential.epochId || value.ownerUserId !== credential.self.id || !integer(value.localCreatedAt) || !isObject(value.input) || value.input.operationId !== value.operationId) return false;
  return parseClientEvent({ v: 1, type: "message.send", requestId: value.operationId, epochId: credential.epochId, payload: value.input }).ok
    && validDelivery(value.delivery, value.operationId, credential.epochId);
}

export class BrowserStorage {
  private readonly prefix: string;
  private readonly ports: Record<StorageKind, StoragePort | null>;
  private readonly usable: Record<StorageKind, boolean>;
  private readonly memory: Record<StorageKind, Map<string, string>> = { session: new Map(), local: new Map() };
  private readonly pending: Record<StorageKind, Set<string>> = { session: new Set(), local: new Set() };
  private readonly now: () => number;
  private readonly apiOrigin: string;

  constructor(apiOrigin: string, options: StorageOptions = {}) {
    this.apiOrigin = apiOrigin.replace(/\/+$/, "");
    this.prefix = `coderoom:${encodeURIComponent(this.apiOrigin)}:`;
    this.now = options.now ?? Date.now;
    this.ports = { session: options.sessionStorage === undefined ? readBrowserStorage("session") : options.sessionStorage, local: options.localStorage === undefined ? readBrowserStorage("local") : options.localStorage };
    this.usable = { session: this.probe("session"), local: this.probe("local") };
  }

  available(kind: StorageKind = "session"): boolean { return this.usable[kind]; }

  readSession(): SessionCredential | null {
    const key = `${this.prefix}session`, record = this.read("session", key);
    if (!isObject(record) || !keys(record, ["schemaVersion", "apiOrigin", "credential"]) || record.schemaVersion !== 1 || record.apiOrigin !== this.apiOrigin) { this.remove("session", key); return null; }
    const parsed = parseSessionCredential(record.credential);
    if (!parsed.ok || parsed.value.expiresAt <= this.now()) { this.remove("session", key); return null; }
    return parsed.value;
  }

  writeSession(credential: SessionCredential): boolean {
    if (!parseSessionCredential(credential).ok || credential.expiresAt <= this.now()) return false;
    const record: StoredSession = { schemaVersion: 1, apiOrigin: this.apiOrigin, credential };
    const result = this.write("session", `${this.prefix}session`, record);
    this.prune(this.stateKey(credential, "composer"));
    return result;
  }

  clearSession(): void { this.remove("session", `${this.prefix}session`); }

  readDraft(credential: SessionCredential): ComposerDraft | null {
    const key = this.stateKey(credential, "composer"), record = this.read("session", key);
    if (!this.matches(record, credential) || !isObject(record) || !keys(record, ["schemaVersion", "apiOrigin", "epochId", "ownerUserId", "roomId", "savedAt", "draft"]) || !integer(record.savedAt) || !validDraft(record.draft, credential)) { this.remove("session", key); return null; }
    return record.draft;
  }

  writeDraft(credential: SessionCredential, draft: ComposerDraft): boolean {
    if (!validDraft(draft, credential)) return false;
    const record: StoredDraft = { schemaVersion: 1, apiOrigin: this.apiOrigin, epochId: credential.epochId, ownerUserId: credential.self.id, roomId: "lobby", savedAt: this.now(), draft };
    const result = this.write("session", this.stateKey(credential, "composer"), record);
    this.prune(this.stateKey(credential, "composer"));
    return result;
  }

  readOutbox(credential: SessionCredential): readonly OutboxEntry[] {
    const key = this.stateKey(credential, "outbox"), record = this.read("session", key);
    if (!this.matches(record, credential) || !isObject(record) || !keys(record, ["schemaVersion", "apiOrigin", "epochId", "ownerUserId", "entries"]) || !Array.isArray(record.entries) || record.entries.length > LIMITS.pendingMessages
      || !record.entries.every(entry => validEntry(entry, credential)) || new Set(record.entries.map(entry => (entry as OutboxEntry).operationId)).size !== record.entries.length) {
      this.remove("session", key); return [];
    }
    return (record.entries as OutboxEntry[]).map(entry => ({ ...entry, delivery: entry.delivery.phase === "sending" ? { phase: "unknown", canRetry: true, reason: "disconnected" } satisfies DeliveryView : entry.delivery }));
  }

  writeOutbox(credential: SessionCredential, entries: readonly OutboxEntry[]): boolean {
    if (entries.length > LIMITS.pendingMessages || !entries.every(entry => validEntry(entry, credential)) || new Set(entries.map(entry => entry.operationId)).size !== entries.length) return false;
    const record: StoredOutbox = { schemaVersion: 1, apiOrigin: this.apiOrigin, epochId: credential.epochId, ownerUserId: credential.self.id, entries };
    const result = this.write("session", this.stateKey(credential, "outbox"), record);
    this.prune(this.stateKey(credential, "outbox"));
    return result;
  }

  readRestoreCredential(): string | null {
    const key = `${this.prefix}identity`, record = this.read("local", key);
    if (isObject(record) && keys(record, ["schemaVersion", "apiOrigin", "identityToken"]) && record.schemaVersion === 1 && record.apiOrigin === this.apiOrigin
      && typeof record.identityToken === "string" && token.test(record.identityToken)) return record.identityToken;
    this.remove("local", key);
    return null;
  }

  writeRestoreCredential(identityToken: string): boolean {
    return typeof identityToken === "string" && token.test(identityToken) && this.write("local", `${this.prefix}identity`, { schemaVersion: 1, apiOrigin: this.apiOrigin, identityToken });
  }

  clearRestoreCredential(): void { this.remove("local", `${this.prefix}identity`); }

  readPreferences(credential?: SessionCredential): LocalPreferences {
    const globalKey = `${this.prefix}preferences`;
    if (!credential) {
      const preferences = migratePreferences(this.read("local", globalKey));
      if (preferences) return preferences;
      this.remove("local", globalKey);
      return defaultPreferences();
    }
    const key = this.identityKey(credential, "preferences"), record = this.read("local", key);
    if (this.matchesIdentity(record, credential) && isObject(record) && keys(record, ["schemaVersion", "apiOrigin", "ownerUserId", "savedAt", "preferences"]) && integer(record.savedAt)) {
      const preferences = migratePreferences(record.preferences);
      if (preferences) return preferences;
    }
    this.remove("local", key);
    const inherited = migratePreferences(this.read("local", globalKey));
    this.remove("local", globalKey);
    if (!inherited) return defaultPreferences();
    this.writePreferences(inherited, credential);
    return inherited;
  }

  writePreferences(preferences: LocalPreferences, credential?: SessionCredential): boolean {
    const normalized = migratePreferences(preferences);
    if (!normalized) return false;
    if (!credential) return this.write("local", `${this.prefix}preferences`, normalized);
    this.remove("local", `${this.prefix}preferences`);
    const key = this.identityKey(credential, "preferences"), record = { schemaVersion: 1, apiOrigin: this.apiOrigin, ownerUserId: credential.self.id, savedAt: this.now(), preferences: normalized };
    const result = this.write("local", key, record);
    this.pruneIdentities(key);
    return result;
  }

  readBookmarks(credential: SessionCredential): readonly StoredBookmark[] {
    const key = this.identityKey(credential, "bookmarks"), record = this.read("local", key);
    if (!this.matchesIdentity(record, credential) || !isObject(record) || !keys(record, ["schemaVersion", "apiOrigin", "ownerUserId", "savedAt", "entries"]) || !integer(record.savedAt)
      || !Array.isArray(record.entries) || !this.validBookmarks(record.entries)) { this.remove("local", key); return []; }
    return record.entries;
  }

  writeBookmarks(credential: SessionCredential, entries: readonly StoredBookmark[]): boolean {
    if (!Array.isArray(entries) || !this.validBookmarks(entries)) return false;
    const key = this.identityKey(credential, "bookmarks"), record = { schemaVersion: 1, apiOrigin: this.apiOrigin, ownerUserId: credential.self.id, savedAt: this.now(), entries };
    const result = this.write("local", key, record);
    this.pruneIdentities(key);
    return result;
  }

  removeBookmark(credential: SessionCredential, bookmarkId: string): boolean {
    return this.writeBookmarks(credential, this.readBookmarks(credential).filter(entry => entry.id !== bookmarkId));
  }

  clearBookmarks(credential: SessionCredential): void { this.remove("local", this.identityKey(credential, "bookmarks")); }

  private validBookmarks(entries: readonly unknown[]): entries is readonly StoredBookmark[] {
    return entries.length <= maxBookmarks && entries.every(validBookmark) && new Set(entries.map(entry => entry.id)).size === entries.length
      && new Set(entries.map(entry => `${entry.epochId}:${entry.messageId}`)).size === entries.length && utf8Bytes(JSON.stringify(entries)) <= LIMITS.historyJsonUtf8Bytes;
  }

  private identityKey(credential: SessionCredential, kind: "preferences" | "bookmarks"): string {
    return `${this.prefix}identity:${credential.self.id}:${kind}`;
  }

  private matchesIdentity(value: unknown, credential: SessionCredential): boolean {
    return isObject(value) && value.schemaVersion === 1 && value.apiOrigin === this.apiOrigin && value.ownerUserId === credential.self.id;
  }

  private stateKey(credential: SessionCredential, kind: "composer" | "outbox"): string {
    return `${this.prefix}state:${credential.self.id}:${credential.roomId}:${credential.epochId}:${kind}`;
  }

  private matches(value: unknown, credential: SessionCredential): boolean {
    return isObject(value) && value.schemaVersion === 1 && value.apiOrigin === this.apiOrigin && value.ownerUserId === credential.self.id && value.epochId === credential.epochId && (value.roomId === undefined || value.roomId === "lobby");
  }

  private probe(kind: StorageKind): boolean {
    const port = this.ports[kind];
    if (!port) return false;
    const key = `${this.prefix}probe:${Math.random().toString(36).slice(2)}`;
    try { port.setItem(key, "1"); const works = port.getItem(key) === "1"; port.removeItem(key); return works; }
    catch { try { port.removeItem(key); } catch {} return false; }
  }

  private read(kind: StorageKind, key: string): unknown {
    let raw = this.memory[kind].get(key) ?? null;
    if (this.ports[kind] && !this.pending[kind].has(key)) {
      try {
        raw = this.ports[kind]?.getItem(key) ?? null;
        if (raw === null) this.memory[kind].delete(key); else this.memory[kind].set(key, raw);
      } catch { this.usable[kind] = false; }
    }
    if (raw === null || utf8Bytes(raw) > maxRecordBytes) return null;
    try { return JSON.parse(raw) as unknown; } catch { return null; }
  }

  private write(kind: StorageKind, key: string, value: unknown): boolean {
    let raw: string;
    try { raw = JSON.stringify(value); } catch { return false; }
    if (utf8Bytes(raw) > maxRecordBytes) return false;
    this.memory[kind].set(key, raw);
    this.pending[kind].add(key);
    if (!this.usable[kind]) return false;
    try { this.ports[kind]?.setItem(key, raw); this.pending[kind].delete(key); return true; }
    catch { this.usable[kind] = false; return false; }
  }

  private remove(kind: StorageKind, key: string): void {
    this.memory[kind].delete(key);
    this.pending[kind].add(key);
    if (!this.ports[kind]) return;
    try { this.ports[kind]?.removeItem(key); this.pending[kind].delete(key); } catch { this.usable[kind] = false; }
  }

  private prune(protectedKey: string): void {
    const prefix = `${this.prefix}state:`, existing = new Set<string>([...this.memory.session.keys()].filter(key => key.startsWith(prefix)));
    const port = this.ports.session;
    if (port) {
      try { for (let i = 0; i < port.length; i++) { const key = port.key(i); if (key?.startsWith(prefix)) existing.add(key); } }
      catch { this.usable.session = false; }
    }
    const scopeOf = (key: string) => key.slice(0, key.lastIndexOf(":"));
    const protectedScope = scopeOf(protectedKey);
    const groups = new Map<string, { keys: string[]; at: number }>();
    for (const key of existing) {
      const scope = scopeOf(key), value = this.read("session", key);
      const group = groups.get(scope) ?? { keys: [], at: 0 };
      group.keys.push(key);
      if (isObject(value) && integer(value.savedAt)) group.at = Math.max(group.at, value.savedAt);
      if (isObject(value) && Array.isArray(value.entries)) {
        for (const entry of value.entries) if (isObject(entry) && integer(entry.localCreatedAt)) group.at = Math.max(group.at, entry.localCreatedAt);
      }
      groups.set(scope, group);
    }
    const ordered = [...groups.entries()].sort(([a, left], [b, right]) => a === protectedScope ? -1 : b === protectedScope ? 1 : right.at - left.at);
    for (const [, group] of ordered.slice(maxStateGroups)) for (const key of group.keys) this.remove("session", key);
  }

  private pruneIdentities(protectedKey: string): void {
    const prefix = `${this.prefix}identity:`, existing = new Set<string>([...this.memory.local.keys()].filter(key => key.startsWith(prefix)));
    const port = this.ports.local;
    if (port) {
      try { for (let i = 0; i < port.length; i++) { const key = port.key(i); if (key?.startsWith(prefix)) existing.add(key); } }
      catch { this.usable.local = false; }
    }
    const scopeOf = (key: string) => key.slice(0, key.lastIndexOf(":")), protectedScope = scopeOf(protectedKey);
    const groups = new Map<string, { keys: string[]; at: number; order: number }>();
    for (const key of existing) {
      const scope = scopeOf(key), value = this.read("local", key), group = groups.get(scope) ?? { keys: [], at: 0, order: groups.size };
      group.keys.push(key);
      if (isObject(value) && integer(value.savedAt)) group.at = Math.max(group.at, value.savedAt);
      groups.set(scope, group);
    }
    const ordered = [...groups.entries()].sort(([a, left], [b, right]) => a === protectedScope ? -1 : b === protectedScope ? 1 : right.at - left.at || right.order - left.order);
    for (const [, group] of ordered.slice(maxLocalIdentityGroups)) for (const key of group.keys) this.remove("local", key);
  }
}

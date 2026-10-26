/**
 * Dependency-free structural and size guards for transport boundaries.
 * They validate shape/size, NOT authorization, idempotency, membership, or revision order.
 */
import { CODE_LANGUAGES, LIMITS, REACTION_EMOJIS } from "./limits.js";
import { ERROR_CODES } from "./errors.js";
import type { ClientEvent, ServerEvent } from "./ws.js";
import type { CreateSessionRequest, SearchRequest, SearchResponse, SessionCredential } from "./http.js";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };
const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (path: string, expectation: string): never => { throw new Error(`${path}: ${expectation}`); };
function obj(value: unknown, keys: readonly string[], path: string, optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
  const result = value as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(result, key)) fail(`${path}.${key}`, "required");
  for (const key of Object.keys(result)) if (![...keys, ...optional].includes(key)) fail(`${path}.${key}`, "unknown field");
  return result;
}
function str(value: unknown, path: string, max = 1_000_000, min = 0): string {
  if (typeof value !== "string") fail(path, "expected string");
  const text = value as string;
  if ([...text].length < min || [...text].length > max) fail(path, `expected ${min}..${max} Unicode code points`);
  return text;
}
function num(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(path, "expected bounded safe integer");
  return value as number;
}
function bool(value: unknown, path: string): void { if (typeof value !== "boolean") fail(path, "expected boolean"); }
function literal(value: unknown, expected: string | number, path: string): void { if (value !== expected) fail(path, `expected ${expected}`); }
function id(value: unknown, path: string): void { if (!uuidPattern.test(str(value, path, 36, 36))) fail(path, "expected lowercase UUID v4"); }
function oneOf(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== "string" || !values.includes(value)) fail(path, "unrecognized value");
}
function arr(value: unknown, max: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected array with at most ${max} entries`);
  return value as unknown[];
}
function nullableId(value: unknown, path: string): void { if (value !== null) id(value, path); }
function user(value: unknown, path: string): void {
  const o = obj(value, ["id", "displayName", "avatarSeed"], path);
  id(o.id, `${path}.id`); str(o.displayName, `${path}.displayName`, LIMITS.nicknameCodePoints, 1);
  str(o.avatarSeed, `${path}.avatarSeed`, 64, 1);
}
function content(value: unknown, path: string): void {
  const candidate = value as Record<string, unknown> | null;
  const kind = candidate?.kind;
  if (kind !== "text" && kind !== "code") fail(path, "expected text or code content");
  const o = obj(value, kind === "text" ? ["kind", "text"] : ["kind", "source", "language"], path);
  const text = str(kind === "text" ? o.text : o.source, `${path}.body`, LIMITS.messageBodyUtf8Bytes, 1);
  if (text.trim().length === 0) fail(path, "content is blank");
  if (utf8Bytes(text) > LIMITS.messageBodyUtf8Bytes) fail(path, "content exceeds UTF-8 byte limit");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) fail(path, "unsupported control character");
  if (kind === "code") oneOf(o.language, CODE_LANGUAGES, `${path}.language`);
}
function reactions(value: unknown, path: string): void {
  const seen = new Set<unknown>();
  arr(value, REACTION_EMOJIS.length, path).forEach((entry, i) => {
    const o = obj(entry, ["emoji", "userIds"], `${path}[${i}]`);
    oneOf(o.emoji, REACTION_EMOJIS, `${path}[${i}].emoji`);
    if (seen.has(o.emoji)) fail(path, "duplicate emoji");
    seen.add(o.emoji);
    const ids = arr(o.userIds, LIMITS.reactionUsersPerEmoji, `${path}[${i}].userIds`);
    if (ids.length === 0 || new Set(ids).size !== ids.length) fail(path, "empty or duplicate membership");
    ids.forEach((value) => id(value, `${path}[${i}].userIds`));
  });
}
function reply(value: unknown, path: string): void {
  if (value === null) return;
  const o = obj(value, ["messageId", "author", "kind", "previewText"], path);
  id(o.messageId, `${path}.messageId`); user(o.author, `${path}.author`);
  oneOf(o.kind, ["text", "code"], `${path}.kind`);
  str(o.previewText, `${path}.previewText`, LIMITS.quotePreviewCodePoints);
}
function message(value: unknown, path: string): void {
  const o = obj(value, ["id", "roomId", "epochId", "clientOperationId", "author", "sequence", "createdAt", "content", "reply", "reactions", "mutationRevision"], path);
  for (const field of ["id", "epochId", "clientOperationId"]) id(o[field], `${path}.${field}`);
  literal(o.roomId, "lobby", `${path}.roomId`); user(o.author, `${path}.author`);
  num(o.sequence, `${path}.sequence`, 1); num(o.createdAt, `${path}.createdAt`);
  num(o.mutationRevision, `${path}.mutationRevision`, 1);
  content(o.content, `${path}.content`); reply(o.reply, `${path}.reply`); reactions(o.reactions, `${path}.reactions`);
}
function history(value: unknown, path: string): void {
  const o = obj(value, ["retainedCount", "limit", "serializedBytes", "maxSerializedBytes", "oldestSequence", "newestSequence", "persistence"], path);
  num(o.retainedCount, `${path}.retainedCount`, 0, LIMITS.historyMessages);
  literal(o.limit, LIMITS.historyMessages, `${path}.limit`);
  num(o.serializedBytes, `${path}.serializedBytes`, 2, LIMITS.historyJsonUtf8Bytes);
  literal(o.maxSerializedBytes, LIMITS.historyJsonUtf8Bytes, `${path}.maxSerializedBytes`);
  oneOf(o.persistence, ["memory-until-server-restart", "sqlite"], `${path}.persistence`);
  for (const key of ["oldestSequence", "newestSequence"]) if (o[key] !== null) num(o[key], `${path}.${key}`, 1);
  if (o.retainedCount === 0 && (o.oldestSequence !== null || o.newestSequence !== null)) fail(path, "empty window must have null sequence bounds");
  if ((o.retainedCount as number) > 0 && (o.oldestSequence === null || o.newestSequence === null)) fail(path, "nonempty window needs sequence bounds");
}
function presence(value: unknown, path: string): void {
  const o = obj(value, ["version", "members"], path); num(o.version, `${path}.version`);
  arr(o.members, LIMITS.onlineUsers, `${path}.members`).forEach((v, i) => user(v, `${path}.members[${i}]`));
}
function typing(value: unknown, path: string): void {
  const o = obj(value, ["version", "entries"], path); num(o.version, `${path}.version`);
  arr(o.entries, LIMITS.onlineUsers, `${path}.entries`).forEach((v, i) => {
    const e = obj(v, ["userId", "expiresAt"], `${path}.entries[${i}]`);
    id(e.userId, `${path}.userId`); num(e.expiresAt, `${path}.expiresAt`);
  });
}
function memberEvent(value: unknown, path: string): void {
  const o = obj(value, ["id", "kind", "user", "occurredAt"], path, ["displayNameChanged"]);
  id(o.id, `${path}.id`); oneOf(o.kind, ["joined", "left", "returned"], `${path}.kind`);
  user(o.user, `${path}.user`); num(o.occurredAt, `${path}.occurredAt`);
  if (o.displayNameChanged !== undefined) bool(o.displayNameChanged, `${path}.displayNameChanged`);
}
function snapshot(value: unknown, path: string): void {
  const o = obj(value, ["roomId", "epochId", "revision", "capturedAt", "messages", "history", "presence", "typing"], path, ["pin", "memberEvents"]);
  literal(o.roomId, "lobby", `${path}.roomId`); id(o.epochId, `${path}.epochId`);
  num(o.revision, `${path}.revision`); num(o.capturedAt, `${path}.capturedAt`);
  arr(o.messages, LIMITS.historyMessages, `${path}.messages`).forEach((v, i) => message(v, `${path}.messages[${i}]`));
  history(o.history, `${path}.history`); presence(o.presence, `${path}.presence`); typing(o.typing, `${path}.typing`);
  if (o.pin !== undefined) pin(o.pin, `${path}.pin`);
  if (o.memberEvents !== undefined) arr(o.memberEvents, 200, `${path}.memberEvents`).forEach((v, i) => memberEvent(v, `${path}.memberEvents[${i}]`));
}
function pin(value: unknown, path: string): void {
  if (value === null) return;
  const o = obj(value, ["message", "pinnedAt", "pinnedBy"], path);
  message(o.message, `${path}.message`); num(o.pinnedAt, `${path}.pinnedAt`); user(o.pinnedBy, `${path}.pinnedBy`);
}
function problem(value: unknown, path: string): void {
  const o = obj(value, ["code", "message", "retryable", "outcome"], path, ["retryAfterMs", "field"]);
  oneOf(o.code, ERROR_CODES, `${path}.code`); str(o.message, `${path}.message`, 500, 1);
  bool(o.retryable, `${path}.retryable`); oneOf(o.outcome, ["not-applied", "unknown"], `${path}.outcome`);
  if (o.retryAfterMs !== undefined) num(o.retryAfterMs, `${path}.retryAfterMs`);
  if (o.field !== undefined) str(o.field, `${path}.field`, 120, 1);
}
function limits(value: unknown, path: string): void {
  const o = obj(value, ["messageBodyUtf8Bytes", "historyMessages", "historyJsonUtf8Bytes", "searchResults", "typingTtlMs", "ackTimeoutMs"], path);
  for (const [key, v] of Object.entries(o)) num(v, `${path}.${key}`, 1);
}
function capture<T>(check: () => T): ParseResult<T> {
  try { return { ok: true, value: check() }; }
  catch (error: unknown) { return { ok: false, issue: error instanceof Error ? error.message : "invalid input" }; }
}
export function parseClientEvent(value: unknown): ParseResult<ClientEvent> {
  return capture(() => {
    const type = (value as Record<string, unknown> | null)?.type;
    const o = obj(value, type === "session.authenticate" ? ["v", "type", "requestId", "payload"] : ["v", "type", "requestId", "epochId", "payload"], "$client");
    literal(o.v, 1, "$client.v"); id(o.requestId, "$client.requestId");
    if (type !== "session.authenticate") id(o.epochId, "$client.epochId");
    switch (type) {
      case "session.authenticate": {
        const p = obj(o.payload, ["token"], "payload");
        if (!/^[0-9a-f]{64}$/.test(str(p.token, "payload.token", 64, 64))) fail("payload.token", "expected 64 lowercase hex characters");
        break;
      }
      case "room.sync": {
        const p = obj(o.payload, ["roomId"], "payload"); literal(p.roomId, "lobby", "payload.roomId"); break;
      }
      case "message.send": {
        const p = obj(o.payload, ["operationId", "roomId", "content", "replyToId"], "payload");
        id(p.operationId, "payload.operationId"); literal(p.roomId, "lobby", "payload.roomId");
        content(p.content, "payload.content"); nullableId(p.replyToId, "payload.replyToId"); break;
      }
      case "reaction.set": {
        const p = obj(o.payload, ["operationId", "roomId", "messageId", "emoji", "active"], "payload");
        id(p.operationId, "payload.operationId"); id(p.messageId, "payload.messageId");
        literal(p.roomId, "lobby", "payload.roomId"); oneOf(p.emoji, REACTION_EMOJIS, "payload.emoji"); bool(p.active, "payload.active"); break;
      }
      case "pin.set": {
        const p = obj(o.payload, ["operationId", "roomId", "messageId"], "payload");
        id(p.operationId, "payload.operationId"); literal(p.roomId, "lobby", "payload.roomId");
        nullableId(p.messageId, "payload.messageId"); break;
      }
      case "typing.set": {
        const p = obj(o.payload, ["roomId", "active"], "payload");
        literal(p.roomId, "lobby", "payload.roomId"); bool(p.active, "payload.active"); break;
      }
      default: fail("$client.type", "unknown event");
    }
    return value as ClientEvent;
  });
}
export function parseServerEvent(value: unknown): ParseResult<ServerEvent> {
  return capture(() => {
    const type = (value as Record<string, unknown> | null)?.type;
    const response = ["session.ready", "room.snapshot", "message.accepted", "reaction.accepted", "pin.accepted"].includes(String(type));
    const o = obj(value, ["v", "type", "epochId", "serverTime", "payload", ...(response ? ["requestId"] : [])], "$server");
    literal(o.v, 1, "$server.v"); id(o.epochId, "$server.epochId"); num(o.serverTime, "$server.serverTime");
    if (response) id(o.requestId, "$server.requestId");
    switch (type) {
      case "session.ready": {
        const p = obj(o.payload, ["connectionId", "self", "expiresAt", "limits", "snapshot"], "payload", ["role"]);
        id(p.connectionId, "payload.connectionId"); user(p.self, "payload.self"); num(p.expiresAt, "payload.expiresAt");
        limits(p.limits, "payload.limits"); snapshot(p.snapshot, "payload.snapshot");
        if (p.role !== undefined) oneOf(p.role, ["guest", "admin"], "payload.role"); break;
      }
      case "room.snapshot": { const p = obj(o.payload, ["snapshot"], "payload"); snapshot(p.snapshot, "payload.snapshot"); break; }
      case "room.delta": {
        const p = obj(o.payload, ["roomId", "revision", "change", "evictedMessageIds", "history"], "payload");
        literal(p.roomId, "lobby", "payload.roomId"); num(p.revision, "payload.revision", 1);
        arr(p.evictedMessageIds, LIMITS.historyMessages, "payload.evictedMessageIds").forEach((v) => id(v, "payload.evictedMessageIds"));
        history(p.history, "payload.history");
        const kind = (p.change as Record<string, unknown> | null)?.kind;
        if (kind === "message.created") {
          const c = obj(p.change, ["kind", "message"], "payload.change"); message(c.message, "payload.change.message");
        } else if (kind === "reaction.changed") {
          const c = obj(p.change, ["kind", "messageId", "reactions"], "payload.change");
          id(c.messageId, "payload.change.messageId"); reactions(c.reactions, "payload.change.reactions");
        } else if (kind === "pin.changed") {
          const c = obj(p.change, ["kind", "pin"], "payload.change"); pin(c.pin, "payload.change.pin");
        } else fail("payload.change.kind", "unknown change");
        break;
      }
      case "message.accepted": {
        const p = obj(o.payload, ["operationId", "messageId", "sequence", "acceptedAt", "appliedRevision", "duplicate", "retained"], "payload");
        id(p.operationId, "payload.operationId"); id(p.messageId, "payload.messageId");
        num(p.sequence, "payload.sequence", 1); num(p.acceptedAt, "payload.acceptedAt"); num(p.appliedRevision, "payload.appliedRevision", 1);
        bool(p.duplicate, "payload.duplicate"); bool(p.retained, "payload.retained"); break;
      }
      case "reaction.accepted": {
        const p = obj(o.payload, ["operationId", "messageId", "emoji", "active", "changed", "appliedRevision", "duplicate", "retained"], "payload");
        id(p.operationId, "payload.operationId"); id(p.messageId, "payload.messageId"); oneOf(p.emoji, REACTION_EMOJIS, "payload.emoji");
        for (const key of ["active", "changed", "duplicate", "retained"]) bool(p[key], `payload.${key}`);
        num(p.appliedRevision, "payload.appliedRevision"); break;
      }
      case "presence.state": presence(o.payload, "payload"); break;
      case "pin.accepted": {
        const p = obj(o.payload, ["operationId", "messageId", "appliedRevision", "duplicate"], "payload");
        id(p.operationId, "payload.operationId"); nullableId(p.messageId, "payload.messageId");
        num(p.appliedRevision, "payload.appliedRevision"); bool(p.duplicate, "payload.duplicate"); break;
      }
      case "member.event": {
        memberEvent(o.payload, "payload"); break;
      }
      case "typing.state": typing(o.payload, "payload"); break;
      case "request.error": {
        const p = obj(o.payload, ["requestId", "operationId", "error"], "payload");
        nullableId(p.requestId, "payload.requestId"); nullableId(p.operationId, "payload.operationId"); problem(p.error, "payload.error"); break;
      }
      case "session.ended": {
        const p = obj(o.payload, ["reason"], "payload"); oneOf(p.reason, ["expired", "replaced", "revoked"], "payload.reason"); break;
      }
      default: fail("$server.type", "unknown event");
    }
    return value as ServerEvent;
  });
}
export function parseClientJson(text: string): ParseResult<ClientEvent> {
  if (utf8Bytes(text) > LIMITS.clientFrameUtf8Bytes) return { ok: false, issue: "client frame too large" };
  try { return parseClientEvent(JSON.parse(text) as unknown); }
  catch { return { ok: false, issue: "invalid JSON" }; }
}
export function parseServerJson(text: string): ParseResult<ServerEvent> {
  if (utf8Bytes(text) > LIMITS.snapshotFrameUtf8Bytes) return { ok: false, issue: "server frame too large" };
  try { return parseServerEvent(JSON.parse(text) as unknown); }
  catch { return { ok: false, issue: "invalid JSON" }; }
}
export function parseCreateSession(value: unknown): ParseResult<CreateSessionRequest> {
  return capture(() => {
    const o = obj(value, ["displayName"], "$join", ["adminPassword", "identityToken"]);
    const displayName = str(o.displayName, "$join.displayName", 200).trim().normalize("NFC");
    str(displayName, "$join.displayName", LIMITS.nicknameCodePoints, 1);
    if (/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(displayName)) fail("$join.displayName", "unsupported control character");
    if (o.adminPassword !== undefined) str(o.adminPassword, "$join.adminPassword", 256);
    if (o.identityToken !== undefined && !/^[0-9a-f]{64}$/.test(str(o.identityToken, "$join.identityToken", 64, 64))) fail("$join.identityToken", "invalid token format");
    return { displayName, ...(o.adminPassword === undefined ? {} : { adminPassword: o.adminPassword as string }), ...(o.identityToken === undefined ? {} : { identityToken: o.identityToken as string }) };
  });
}
export function parseSessionCredential(value: unknown): ParseResult<SessionCredential> {
  return capture(() => {
    const o = obj(value, ["protocolVersion", "epochId", "roomId", "self", "bearerToken", "expiresAt"], "$session", ["identityToken", "role"]);
    literal(o.protocolVersion, 1, "$session.protocolVersion"); id(o.epochId, "$session.epochId"); literal(o.roomId, "lobby", "$session.roomId");
    user(o.self, "$session.self"); num(o.expiresAt, "$session.expiresAt");
    if (!/^[0-9a-f]{64}$/.test(str(o.bearerToken, "$session.bearerToken", 64, 64))) fail("$session.bearerToken", "invalid token format");
    if (o.identityToken !== undefined && !/^[0-9a-f]{64}$/.test(str(o.identityToken, "$session.identityToken", 64, 64))) fail("$session.identityToken", "invalid token format");
    if (o.role !== undefined) oneOf(o.role, ["guest", "admin"], "$session.role");
    return value as SessionCredential;
  });
}
export function parseSearchRequest(value: unknown): ParseResult<SearchRequest> {
  return capture(() => {
    const o = obj(value, ["query", "limit"], "$search");
    const query = str(o.query, "$search.query", 500).trim();
    str(query, "$search.query", LIMITS.searchQueryCodePoints, 1);
    return { query, limit: num(o.limit, "$search.limit", 1, LIMITS.searchResults) };
  });
}
export function parseSearchResponse(value: unknown): ParseResult<SearchResponse> {
  return capture(() => {
    const o = obj(value, ["epochId", "roomId", "query", "asOfRevision", "searchedAt", "history", "totalMatches", "truncated", "results"], "$searchResponse");
    id(o.epochId, "epochId"); literal(o.roomId, "lobby", "roomId"); str(o.query, "query", LIMITS.searchQueryCodePoints, 1);
    num(o.asOfRevision, "asOfRevision"); num(o.searchedAt, "searchedAt"); history(o.history, "history");
    num(o.totalMatches, "totalMatches", 0, LIMITS.historyMessages); bool(o.truncated, "truncated");
    arr(o.results, LIMITS.searchResults, "results").forEach((value, i) => {
      const p = `results[${i}]`;
      const hit = obj(value, ["messageId", "sequence", "author", "createdAt", "kind", "snippet", "matches"], p);
      id(hit.messageId, `${p}.messageId`); num(hit.sequence, `${p}.sequence`, 1); user(hit.author, `${p}.author`);
      num(hit.createdAt, `${p}.createdAt`); oneOf(hit.kind, ["text", "code"], `${p}.kind`);
      const text = str(hit.snippet, `${p}.snippet`, LIMITS.searchSnippetCodePoints);
      let previousEnd = 0;
      arr(hit.matches, 100, `${p}.matches`).forEach((range) => {
        const r = obj(range, ["start", "end"], `${p}.range`);
        const start = num(r.start, `${p}.start`, 0, text.length);
        const end = num(r.end, `${p}.end`, 1, text.length);
        if (start >= end || start < previousEnd) fail(p, "invalid or overlapping highlight ranges");
        previousEnd = end;
      });
    });
    return value as SearchResponse;
  });
}

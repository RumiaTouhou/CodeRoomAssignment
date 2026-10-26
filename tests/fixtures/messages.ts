import type { ChatMessage, HistoryWindow, PublicUser, RoomSnapshot } from "../../shared/domain.js";
import type { PublicLimits, SearchResponse, SessionCredential } from "../../shared/http.js";
import { LIMITS } from "../../shared/limits.js";
import { utf8Bytes } from "../../shared/validation.js";

export const fixtureId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const SAMPLE_EPOCH = fixtureId(1_000);
export const SAMPLE_NOW = Date.parse("2026-10-21T10:00:00.000Z");
export const ALICE: PublicUser = { id: fixtureId(1), displayName: "Alice", avatarSeed: "alice" };
export const BOB: PublicUser = { id: fixtureId(2), displayName: "Bob", avatarSeed: "bob" };
export const CHEN: PublicUser = { id: fixtureId(3), displayName: "Chen", avatarSeed: "chen" };
export const SAMPLE_USERS = [ALICE, BOB, CHEN] as const;
export const RAW_CODE = 'export function preview(value: string) {\n\tconst literal = "**do not format**";\n\tconst html = "<div>plain text</div>";\n\treturn { value, literal, html };\n}\n';
const makeMessage = (
  sequence: number, author: PublicUser, content: ChatMessage["content"],
  reply: ChatMessage["reply"] = null,
): ChatMessage => ({
  id: fixtureId(100 + sequence), roomId: "lobby", epochId: SAMPLE_EPOCH,
  clientOperationId: fixtureId(200 + sequence), author, sequence,
  createdAt: SAMPLE_NOW - (9 - sequence) * 20_000, content, reply,
  reactions: [], mutationRevision: sequence,
});
const m1 = makeMessage(1, ALICE, { kind: "text", text: "ACK timeout does not prove that a message was rejected." });
const m2 = makeMessage(2, BOB, { kind: "text", text: "Plain text **literal** stays unchanged instead of becoming bold." });
const m3 = makeMessage(3, ALICE, { kind: "code", source: RAW_CODE, language: "typescript" });
const m4 = makeMessage(4, BOB, { kind: "text", text: "Copied. Indentation and asterisks are preserved in this quoted code." }, {
  messageId: m3.id, author: ALICE, kind: "code", previewText: "export function preview(value: string) {",
});
const m5 = makeMessage(5, ALICE, { kind: "text", text: "Next, inspect search and reading position." });
const m6 = makeMessage(6, ALICE, { kind: "text", text: "Search ACK to return to the earlier discussion." });
const m7 = makeMessage(7, ALICE, { kind: "text", text: "Incoming messages preserve the current reading position." });
const m8 = makeMessage(8, CHEN, {
  kind: "text", text: 'Special content remains plain text: <script>alert("not executed")</script> Hello 👩🏽‍💻\n' +
    "Long identifier: " + "long_identifier_".repeat(15),
});
export const SAMPLE_MESSAGES: readonly ChatMessage[] = [
  m1, m2,
  { ...m3, reactions: [{ emoji: "✅", userIds: [BOB.id, CHEN.id] }], mutationRevision: 9 },
  m4, m5, m6, m7,
  { ...m8, reactions: [{ emoji: "👍", userIds: [ALICE.id] }], mutationRevision: 10 },
];
export function historyFor(messages: readonly ChatMessage[]): HistoryWindow {
  return {
    retainedCount: messages.length, limit: LIMITS.historyMessages,
    serializedBytes: utf8Bytes(JSON.stringify(messages)), maxSerializedBytes: LIMITS.historyJsonUtf8Bytes,
    oldestSequence: messages[0]?.sequence ?? null, newestSequence: messages.at(-1)?.sequence ?? null,
    persistence: "memory-until-server-restart",
  };
}
export function snapshotFor(messages: readonly ChatMessage[], revision: number): RoomSnapshot {
  return {
    roomId: "lobby", epochId: SAMPLE_EPOCH, revision, capturedAt: SAMPLE_NOW,
    messages, history: historyFor(messages),
    presence: { version: 3, members: SAMPLE_USERS }, typing: { version: 0, entries: [] },
  };
}
export const SAMPLE_SNAPSHOT = snapshotFor(SAMPLE_MESSAGES, 10);
export const SAMPLE_PUBLIC_LIMITS: PublicLimits = {
  messageBodyUtf8Bytes: LIMITS.messageBodyUtf8Bytes, historyMessages: LIMITS.historyMessages,
  historyJsonUtf8Bytes: LIMITS.historyJsonUtf8Bytes, searchResults: LIMITS.searchResults,
  typingTtlMs: LIMITS.typingTtlMs, ackTimeoutMs: LIMITS.ackTimeoutMs,
};

export const SAMPLE_CREDENTIAL: SessionCredential = {
  protocolVersion: 1, epochId: SAMPLE_EPOCH, roomId: "lobby", self: ALICE,
  bearerToken: "0".repeat(64), expiresAt: SAMPLE_NOW + LIMITS.sessionTtlMs,
};
export const SAMPLE_SEARCH: SearchResponse = {
  epochId: SAMPLE_EPOCH, roomId: "lobby", query: "ACK", asOfRevision: 10,
  searchedAt: SAMPLE_NOW, history: SAMPLE_SNAPSHOT.history, totalMatches: 2, truncated: false,
  results: [m6, m1].map((message) => {
    const snippet = message.content.kind === "text" ? message.content.text : message.content.source;
    const start = snippet.indexOf("ACK");
    return {
      messageId: message.id, sequence: message.sequence, author: message.author,
      createdAt: message.createdAt, kind: message.content.kind,
      snippet, matches: [{ start, end: start + 3 }],
    };
  }),
};

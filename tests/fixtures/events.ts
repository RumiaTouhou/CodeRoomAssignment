import type { ClientEvent, ServerEvent } from "../../shared/ws.js";
import type { ChatMessage } from "../../shared/domain.js";
import {
  ALICE, BOB, SAMPLE_CREDENTIAL, SAMPLE_EPOCH, SAMPLE_MESSAGES, SAMPLE_NOW,
  SAMPLE_PUBLIC_LIMITS, fixtureId, historyFor, snapshotFor,
} from "./messages.js";

export type TransportCase =
  | { readonly atMs: number; readonly direction: "client-to-server"; readonly event: ClientEvent }
  | { readonly atMs: number; readonly direction: "server-to-client"; readonly event: ServerEvent };
const firstTwo = SAMPLE_MESSAGES.slice(0, 2);
const sentCode: ChatMessage = { ...SAMPLE_MESSAGES[2]!, reactions: [], mutationRevision: 3 };
const afterSend = [...firstTwo, sentCode];
const afterReaction = [...firstTwo, { ...sentCode, reactions: [{ emoji: "✅" as const, userIds: [BOB.id] }], mutationRevision: 4 }];
const envelope = { v: 1, epochId: SAMPLE_EPOCH, serverTime: SAMPLE_NOW } as const;
export const SAMPLE_TRANSCRIPT: readonly TransportCase[] = [
  { atMs: 0, direction: "client-to-server", event: { v: 1, type: "session.authenticate", requestId: fixtureId(600), payload: { token: SAMPLE_CREDENTIAL.bearerToken } } },
  { atMs: 50, direction: "server-to-client", event: {
    ...envelope, type: "session.ready", requestId: fixtureId(600),
    payload: { connectionId: fixtureId(500), self: ALICE, expiresAt: SAMPLE_CREDENTIAL.expiresAt, limits: SAMPLE_PUBLIC_LIMITS, snapshot: snapshotFor(firstTwo, 2) },
  } },
  { atMs: 100, direction: "client-to-server", event: { v: 1, type: "typing.set", epochId: SAMPLE_EPOCH, requestId: fixtureId(601), payload: { roomId: "lobby", active: true } } },
  { atMs: 120, direction: "server-to-client", event: { ...envelope, type: "typing.state", payload: { version: 1, entries: [{ userId: ALICE.id, expiresAt: SAMPLE_NOW + 4_000 }] } } },
  { atMs: 500, direction: "client-to-server", event: {
    v: 1, type: "message.send", epochId: SAMPLE_EPOCH, requestId: fixtureId(602),
    payload: { operationId: sentCode.clientOperationId, roomId: "lobby", content: sentCode.content, replyToId: null },
  } },
  { atMs: 550, direction: "server-to-client", event: { ...envelope, type: "room.delta", payload: {
    roomId: "lobby", revision: 3, change: { kind: "message.created", message: sentCode }, evictedMessageIds: [], history: historyFor(afterSend),
  } } },
  { atMs: 551, direction: "server-to-client", event: { ...envelope, type: "message.accepted", requestId: fixtureId(602), payload: {
    operationId: sentCode.clientOperationId, messageId: sentCode.id, sequence: sentCode.sequence,
    acceptedAt: sentCode.createdAt, appliedRevision: 3, duplicate: false, retained: true,
  } } },
  { atMs: 552, direction: "server-to-client", event: { ...envelope, type: "typing.state", payload: { version: 2, entries: [] } } },
  { atMs: 1_000, direction: "server-to-client", event: { ...envelope, type: "room.delta", payload: {
    roomId: "lobby", revision: 4, change: { kind: "reaction.changed", messageId: sentCode.id, reactions: afterReaction[2]!.reactions }, evictedMessageIds: [], history: historyFor(afterReaction),
  } } },
  { atMs: 1_500, direction: "client-to-server", event: {
    v: 1, type: "message.send", epochId: SAMPLE_EPOCH, requestId: fixtureId(603),
    payload: { operationId: sentCode.clientOperationId, roomId: "lobby", content: sentCode.content, replyToId: null },
  } },
  { atMs: 1_550, direction: "server-to-client", event: { ...envelope, type: "message.accepted", requestId: fixtureId(603), payload: {
    operationId: sentCode.clientOperationId, messageId: sentCode.id, sequence: sentCode.sequence,
    acceptedAt: sentCode.createdAt, appliedRevision: 3, duplicate: true, retained: true,
  } } },
];

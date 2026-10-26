import type { ChatMessage, RoomDelta, RoomSnapshot } from "../../../shared/domain.js";
import type { OutboxEntry } from "../../../shared/persistence.js";
import type { ComposerDraft, ComposerView, ConnectionView, DraftIntent } from "../../../shared/ui.js";
import { LIMITS } from "../../../shared/limits.js";
import { snapshotInvariantErrors } from "../../../shared/invariants.js";
import { utf8Bytes } from "../../../shared/validation.js";

export function advanceDraft(draft: ComposerDraft, intent: DraftIntent): ComposerDraft {
  const next = { ...draft, revision: draft.revision + 1 };
  switch (intent.type) {
    case "text.changed": return { ...next, textBuffer: intent.value };
    case "code.changed": return { ...next, codeBuffer: { ...draft.codeBuffer, source: intent.value } };
    case "mode.changed": return { ...next, mode: intent.value };
    case "language.changed": return { ...next, codeBuffer: { ...draft.codeBuffer, language: intent.value } };
    case "reply.cleared": return { ...next, replyTarget: null };
  }
}

export function reconcileOutbox(entries: readonly OutboxEntry[], messages: readonly ChatMessage[]): OutboxEntry[] {
  const accepted = new Set(messages.map(message => `${message.author.id}:${message.clientOperationId}`));
  return entries.filter(entry => !accepted.has(`${entry.ownerUserId}:${entry.operationId}`));
}

export function applyRoomDelta(snapshot: RoomSnapshot, delta: RoomDelta):
  { readonly kind: "applied"; readonly snapshot: RoomSnapshot } | { readonly kind: "duplicate" } | { readonly kind: "gap" } {
  if (delta.revision <= snapshot.revision) return { kind: "duplicate" };
  if (delta.revision !== snapshot.revision + 1 || delta.roomId !== snapshot.roomId) return { kind: "gap" };
  let messages: readonly ChatMessage[];
  if (delta.change.kind === "message.created") {
    const message = delta.change.message;
    if (message.epochId !== snapshot.epochId || message.roomId !== snapshot.roomId || message.mutationRevision !== delta.revision || snapshot.messages.some(item => item.id === message.id)
      || message.sequence <= (snapshot.messages.at(-1)?.sequence ?? 0)) return { kind: "gap" };
    messages = [...snapshot.messages, message];
  } else if (delta.change.kind === "reaction.changed") {
    const change = delta.change;
    if (!snapshot.messages.some(message => message.id === change.messageId)) return { kind: "gap" };
    messages = snapshot.messages.map(message => message.id === change.messageId
      ? { ...message, reactions: change.reactions, mutationRevision: delta.revision } : message);
  } else {
    messages = snapshot.messages;
  }
  const evicted = new Set(delta.evictedMessageIds);
  messages = messages.filter(message => !evicted.has(message.id));
  if (messages.length !== delta.history.retainedCount || delta.history.oldestSequence !== (messages[0]?.sequence ?? null)
    || delta.history.newestSequence !== (messages.at(-1)?.sequence ?? null)
    || delta.history.serializedBytes !== utf8Bytes(JSON.stringify(messages))) return { kind: "gap" };
  const candidate = { ...snapshot, ...(delta.change.kind === "pin.changed" ? { pin: delta.change.pin } : {}), revision: delta.revision, messages, history: delta.history };
  if (snapshotInvariantErrors(candidate).length) return { kind: "gap" };
  return { kind: "applied", snapshot: candidate };
}

export function composerDisabledReason(draft: ComposerDraft, connection: ConnectionView, pendingCount: number): ComposerView["disabledReason"] {
  if (connection.phase === "ended") return "session-ended";
  if (connection.phase === "connecting" || connection.phase === "synchronizing") return "synchronizing";
  if (connection.phase !== "ready") return "offline";
  const body = draft.mode === "text" ? draft.textBuffer : draft.codeBuffer.source;
  if (utf8Bytes(body) > LIMITS.messageBodyUtf8Bytes) return "too-large";
  if (!body.trim()) return "empty";
  if (pendingCount >= LIMITS.pendingMessages) return "outbox-full";
  return null;
}

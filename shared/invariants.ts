import type { RoomSnapshot } from "./domain.js";
import { LIMITS } from "./limits.js";
import { utf8Bytes } from "./validation.js";

/** Semantic snapshot checks, additional to structural boundary validation. */
export function snapshotInvariantErrors(snapshot: RoomSnapshot): readonly string[] {
  const errors: string[] = [];
  const messages = snapshot.messages;
  const ids = new Set<string>();
  const operations = new Set<string>();
  let previous = 0;
  for (const m of messages) {
    if (ids.has(m.id)) errors.push("duplicate message ID");
    ids.add(m.id);
    const key = `${m.author.id}:${m.clientOperationId}`;
    if (operations.has(key)) errors.push("duplicate logical send");
    operations.add(key);
    if (m.sequence <= previous) errors.push("message sequence is not strictly ascending");
    previous = m.sequence;
    if (m.epochId !== snapshot.epochId || m.roomId !== snapshot.roomId) errors.push("message belongs to another room epoch");
    if (m.mutationRevision > snapshot.revision) errors.push("message revision exceeds snapshot");
    if (m.reply?.messageId === m.id) errors.push("self-reference");
  }
  const h = snapshot.history;
  if (h.retainedCount !== messages.length) errors.push("history count mismatch");
  if (h.oldestSequence !== (messages[0]?.sequence ?? null)) errors.push("oldest sequence mismatch");
  if (h.newestSequence !== (messages.at(-1)?.sequence ?? null)) errors.push("newest sequence mismatch");
  if (h.serializedBytes !== utf8Bytes(JSON.stringify(messages))) errors.push("serialized history size mismatch");
  if (messages.length > LIMITS.historyMessages || h.serializedBytes > LIMITS.historyJsonUtf8Bytes) errors.push("history capacity exceeded");
  const memberIds = new Set(snapshot.presence.members.map((u) => u.id));
  if (memberIds.size !== snapshot.presence.members.length) errors.push("duplicate online member");
  const typingIds = new Set(snapshot.typing.entries.map((t) => t.userId));
  if (typingIds.size !== snapshot.typing.entries.length) errors.push("duplicate typing member");
  for (const t of snapshot.typing.entries) if (!memberIds.has(t.userId)) errors.push("typing user is not online");
  if (snapshot.pin && (snapshot.pin.message.epochId !== snapshot.epochId || snapshot.pin.message.roomId !== snapshot.roomId)) errors.push("pin belongs to another room epoch");
  if (snapshot.pin && snapshot.pin.message.mutationRevision > snapshot.revision) errors.push("pin revision exceeds snapshot");
  if (snapshot.memberEvents) {
    const eventIds = new Set(snapshot.memberEvents.map(event => event.id));
    if (eventIds.size !== snapshot.memberEvents.length) errors.push("duplicate member event");
  }
  return errors;
}

import type { ComposerDraft, ComposerView, ConnectionView } from "../contract.js";
import { utf8Bytes } from "../../../shared/validation.js";

/** Compute consistent composer state for preview scenarios. */
export function projectPreviewComposer(base: ComposerView, draft: ComposerDraft, shortcut: ComposerView["shortcut"], connection: ConnectionView): ComposerView {
  const body = draft.mode === "code" ? draft.codeBuffer.source : draft.textBuffer;
  const bytes = utf8Bytes(body);
  const reason: ComposerView["disabledReason"] = connection.phase === "ended" ? "session-ended"
    : connection.phase === "connecting" || connection.phase === "synchronizing" ? "synchronizing"
    : connection.phase !== "ready" ? "offline"
    : bytes > base.bodyLimitUtf8Bytes ? "too-large"
    : !body.trim() ? "empty"
    : base.disabledReason === "outbox-full" ? "outbox-full" : null;
  return { ...base, draft, shortcut, bodyUtf8Bytes: bytes, canSubmit: reason === null, disabledReason: reason,
    replyPreview: draft.replyTarget === null ? null : base.replyPreview };
}

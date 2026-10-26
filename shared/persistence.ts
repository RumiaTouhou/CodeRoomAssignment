import type { EpochId, MessageContent, OperationId, PublicUser, SendMessageInput, UnixMs, UserId } from "./domain.js";
import type { SessionCredential } from "./http.js";
import type { ComposerDraft, DeliveryView } from "./ui.js";

/** Session, draft and outbox are TAB-scoped sessionStorage records, not localStorage. */
export interface StoredSession {
  readonly schemaVersion: 1;
  readonly apiOrigin: string;
  readonly credential: SessionCredential;
}
export interface StoredDraft {
  readonly schemaVersion: 1;
  readonly apiOrigin: string;
  readonly epochId: EpochId;
  readonly ownerUserId: UserId;
  readonly roomId: "lobby";
  readonly savedAt: UnixMs;
  readonly draft: ComposerDraft;
}
export interface OutboxEntry {
  readonly operationId: OperationId;
  readonly epochId: EpochId;
  readonly ownerUserId: UserId;
  readonly localCreatedAt: UnixMs;
  readonly input: SendMessageInput;
  readonly delivery: Exclude<DeliveryView, { readonly phase: "incoming" } | { readonly phase: "confirmed" }>;
}
export interface StoredOutbox {
  readonly schemaVersion: 1;
  readonly apiOrigin: string;
  readonly epochId: EpochId;
  readonly ownerUserId: UserId;
  readonly entries: readonly OutboxEntry[];
}
export interface ReadingAnchor {
  readonly epochId: EpochId;
  readonly messageId: string;
  /** Message top minus viewport top, may be negative for a partially visible row. */
  readonly offsetPx: number;
}

export interface StoredBookmark {
  readonly id: string;
  readonly epochId: EpochId;
  readonly messageId: string;
  readonly author: PublicUser;
  readonly createdAt: UnixMs;
  readonly savedAt: UnixMs;
  readonly content: MessageContent;
}

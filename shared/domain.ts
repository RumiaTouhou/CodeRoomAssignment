import type { CodeLanguage, ReactionEmoji } from "./limits.js";

/** UUID-shaped strings on the wire; never infer ownership from a supplied ID. */
export type UserId = string;
export type MessageId = string;
export type OperationId = string;
export type RequestId = string;
export type EpochId = string;
export type ConnectionId = string;
export type RoomId = "lobby";
export type MemberEventKind = "joined" | "left" | "returned";
/** Safe, nonnegative integer, Unix milliseconds. */
export type UnixMs = number;
/** Safe integer; zero is valid for an empty room. */
export type RoomRevision = number;
export type MessageSequence = number;

export interface PublicUser {
  readonly id: UserId;
  readonly displayName: string;
  /** Non-secret, deterministic avatar input. Not an arbitrary remote image URL. */
  readonly avatarSeed: string;
}
export type MessageContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly source: string; readonly language: CodeLanguage };

/** Server-built, immutable quote snapshot. Never accepts user-supplied quote text. */
export interface ReplyReference {
  readonly messageId: MessageId;
  readonly author: PublicUser;
  readonly kind: MessageContent["kind"];
  readonly previewText: string;
}
export interface ReactionMembership {
  readonly emoji: ReactionEmoji;
  /** Unique IDs; empty reactions are omitted. Count is derived, never authoritative. */
  readonly userIds: readonly UserId[];
}
export interface ChatMessage {
  readonly id: MessageId;
  readonly roomId: RoomId;
  readonly epochId: EpochId;
  /** Stable key for a logical send, also present on a pending local row. */
  readonly clientOperationId: OperationId;
  readonly author: PublicUser;
  /** Server assigned; immutable ordering. Never sort confirmed messages by local clocks. */
  readonly sequence: MessageSequence;
  readonly createdAt: UnixMs;
  readonly content: MessageContent;
  readonly reply: ReplyReference | null;
  readonly reactions: readonly ReactionMembership[];
  /** Room revision of the latest mutation to this message. */
  readonly mutationRevision: RoomRevision;
}
export interface HistoryWindow {
  readonly retainedCount: number;
  readonly limit: number;
  /** UTF-8 byte length of JSON.stringify(messages), including metadata and reactions. */
  readonly serializedBytes: number;
  readonly maxSerializedBytes: number;
  readonly oldestSequence: MessageSequence | null;
  readonly newestSequence: MessageSequence | null;
  readonly persistence: "memory-until-server-restart" | "sqlite";
}
export type SessionRole = "guest" | "admin";
export interface PublicPin {
  readonly message: ChatMessage;
  readonly pinnedAt: UnixMs;
  readonly pinnedBy: PublicUser;
}
export interface MemberEvent {
  readonly id: string;
  readonly kind: MemberEventKind;
  readonly user: PublicUser;
  readonly occurredAt: UnixMs;
  readonly displayNameChanged?: boolean;
}
export interface PresenceState {
  readonly version: number;
  /** Distinct live guest sessions, not a count of TCP connections. */
  readonly members: readonly PublicUser[];
}
export interface TypingEntry {
  readonly userId: UserId;
  readonly expiresAt: UnixMs;
}
export interface TypingState {
  readonly version: number;
  readonly entries: readonly TypingEntry[];
}
export interface RoomSnapshot {
  readonly roomId: RoomId;
  readonly epochId: EpochId;
  readonly revision: RoomRevision;
  readonly capturedAt: UnixMs;
  /** Full retained window, ascending by sequence. */
  readonly messages: readonly ChatMessage[];
  readonly history: HistoryWindow;
  readonly presence: PresenceState;
  readonly typing: TypingState;
  readonly pin?: PublicPin | null;
  readonly memberEvents?: readonly MemberEvent[];
}
export type RoomChange =
  | { readonly kind: "message.created"; readonly message: ChatMessage }
  | {
      readonly kind: "reaction.changed";
      readonly messageId: MessageId;
      readonly reactions: readonly ReactionMembership[];
    }
  | { readonly kind: "pin.changed"; readonly pin: PublicPin | null };
export interface RoomDelta {
  readonly roomId: RoomId;
  readonly revision: RoomRevision;
  readonly change: RoomChange;
  /** Apply the change, then eviction, as one transaction. */
  readonly evictedMessageIds: readonly MessageId[];
  readonly history: HistoryWindow;
}
export interface SendMessageInput {
  readonly operationId: OperationId;
  readonly roomId: RoomId;
  readonly content: MessageContent;
  readonly replyToId: MessageId | null;
}
export interface SetReactionInput {
  readonly operationId: OperationId;
  readonly roomId: RoomId;
  readonly messageId: MessageId;
  readonly emoji: ReactionEmoji;
  /** Explicit target state, never TOGGLE. */
  readonly active: boolean;
}
export interface MessageReceipt {
  readonly operationId: OperationId;
  readonly messageId: MessageId;
  readonly sequence: MessageSequence;
  readonly acceptedAt: UnixMs;
  readonly appliedRevision: RoomRevision;
  readonly duplicate: boolean;
  readonly retained: boolean;
}
export interface ReactionReceipt {
  readonly operationId: OperationId;
  readonly messageId: MessageId;
  readonly emoji: ReactionEmoji;
  readonly active: boolean;
  readonly changed: boolean;
  readonly appliedRevision: RoomRevision;
  readonly duplicate: boolean;
  readonly retained: boolean;
}
export interface SetPinInput {
  readonly operationId: OperationId;
  readonly roomId: RoomId;
  readonly messageId: MessageId | null;
}
export interface PinReceipt {
  readonly operationId: OperationId;
  readonly messageId: MessageId | null;
  readonly appliedRevision: RoomRevision;
  readonly duplicate: boolean;
}
export const rawContent = (content: MessageContent): string =>
  content.kind === "text" ? content.text : content.source;

import type {
  ChatMessage, EpochId, HistoryWindow, MessageContent, MessageId,
  OperationId, PublicUser, ReplyReference, RoomId, SessionRole, UnixMs,
} from "./domain.js";
import type { Problem } from "./errors.js";
import type { HighlightRange, SearchResponse } from "./http.js";
import type { CodeLanguage, ReactionEmoji } from "./limits.js";

/** UI-only types. No bearer token, socket instance, or mock transport belongs here. */
export type RenderKey = string;
export type ConnectionView =
  | { readonly phase: "connecting" }
  | { readonly phase: "synchronizing" }
  | { readonly phase: "ready" }
  | { readonly phase: "reconnecting"; readonly attempt: number; readonly nextAttemptAt: UnixMs }
  | { readonly phase: "offline"; readonly canRetry: boolean }
  | { readonly phase: "ended"; readonly reason: "expired" | "replaced" | "revoked" | "server-restarted" };

export type ReadingSize = "standard" | "large" | "larger";
export interface LocalPreferences {
  readonly schemaVersion: 1;
  readonly soundMode: "off" | "incoming";
  readonly textSendShortcut: "enter" | "mod-enter";
  readonly shareTyping: boolean;
  readonly readingSize?: ReadingSize;
  readonly memberSounds?: boolean;
}
export interface SoundView {
  readonly mode: LocalPreferences["soundMode"];
  /** A saved preference is not evidence that the browser allowed audio playback. */
  readonly playback: "not-enabled" | "unverified" | "ready" | "blocked" | "unavailable";
}
export interface ReplyTarget { readonly epochId: EpochId; readonly messageId: MessageId }
export interface ComposerDraft {
  readonly schemaVersion: 1;
  /** Increment on every accepted draft change; never reset to clear an old ACK. */
  readonly revision: number;
  readonly mode: "text" | "code";
  readonly textBuffer: string;
  readonly codeBuffer: { readonly source: string; readonly language: CodeLanguage };
  readonly replyTarget: ReplyTarget | null;
}
export interface QuoteView extends ReplyReference {
  readonly availability: "available" | "expired";
}
export interface ComposerView {
  readonly draft: ComposerDraft;
  readonly replyPreview: QuoteView | null;
  readonly canSubmit: boolean;
  readonly disabledReason: "empty" | "offline" | "synchronizing" | "too-large" | "outbox-full" | "session-ended" | null;
  readonly bodyUtf8Bytes: number;
  readonly bodyLimitUtf8Bytes: number;
  readonly isComposing: boolean;
  readonly draftStorage: "available" | "unavailable";
  readonly shortcut: LocalPreferences["textSendShortcut"];
  readonly error: string | null;
}
export type DraftIntent =
  | { readonly type: "text.changed"; readonly value: string }
  | { readonly type: "code.changed"; readonly value: string }
  | { readonly type: "mode.changed"; readonly value: "text" | "code" }
  | { readonly type: "language.changed"; readonly value: CodeLanguage }
  | { readonly type: "reply.cleared" };
export interface SubmitIntent {
  readonly draftRevision: number;
  readonly trigger: "button" | "shortcut";
}
/** UI forwards DOM facts; the application layer decides whether to send. */
export interface ComposerKeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly legacyKeyCode: number;
}
export type DeliveryView =
  | { readonly phase: "incoming" }
  | { readonly phase: "confirmed" }
  | { readonly phase: "sending" }
  | { readonly phase: "unknown"; readonly canRetry: boolean; readonly reason: "timeout" | "disconnected" | "server-error" | "session-lost" }
  | { readonly phase: "rejected"; readonly error: Problem }
  | { readonly phase: "accepted-outside-history" };
export interface ReactionView {
  readonly emoji: ReactionEmoji;
  readonly count: number;
  readonly reactedByMe: boolean;
  readonly pending: boolean;
  readonly enabled: boolean;
}
export interface MessageView {
  /** Derived from author.id + clientOperationId; unchanged by confirmation. */
  readonly key: RenderKey;
  readonly identity:
    | { readonly kind: "canonical"; readonly messageId: MessageId; readonly sequence: number }
    | { readonly kind: "outbox"; readonly operationId: OperationId };
  readonly author: PublicUser;
  readonly isMine: boolean;
  readonly createdAt: UnixMs;
  readonly content: MessageContent;
  readonly systemEvent?: "joined" | "left" | "returned";
  readonly delivery: DeliveryView;
  readonly quote: QuoteView | null;
  readonly reactions: readonly ReactionView[];
  readonly grouping: "start" | "continuation";
  readonly actions: {
    readonly canReply: boolean;
    readonly canReact: boolean;
    readonly canRestoreToComposer: boolean;
    readonly canPin?: boolean;
  };
  readonly fold?: { readonly collapsible: boolean; readonly expanded: boolean };
  readonly bookmarked?: boolean;
  readonly highlighted: boolean;
  /** Offsets into rawContent(content), not syntax-highlighted HTML. */
  readonly searchMatches: readonly HighlightRange[];
}
export type TimelineItem =
  | { readonly type: "message"; readonly key: RenderKey; readonly message: MessageView }
  | { readonly type: "date-separator"; readonly key: RenderKey; readonly label: string }
  | { readonly type: "history-boundary"; readonly key: RenderKey; readonly label: string };
export interface TimelineView {
  readonly items: readonly TimelineItem[];
  readonly unseenIncomingCount: number;
  readonly atBottom: boolean;
  readonly navigationMode: "following" | "reading" | "search" | "quote";
  readonly canReturnToReadingPosition: boolean;
  readonly highlightedMessageId: MessageId | null;
}
export type SearchView =
  | { readonly phase: "closed"; readonly query: string }
  | { readonly phase: "idle"; readonly query: string }
  | { readonly phase: "loading"; readonly query: string }
  | { readonly phase: "results"; readonly query: string; readonly response: SearchResponse; readonly mayBeStale: boolean }
  | { readonly phase: "empty"; readonly query: string; readonly response: SearchResponse }
  | { readonly phase: "error"; readonly query: string; readonly message: string; readonly retryable: boolean };
export interface TypingView { readonly users: readonly PublicUser[] }
export interface NoticeView {
  readonly id: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly dismissible: boolean;
}
export interface BookmarkView {
  readonly id: string;
  readonly author: PublicUser;
  readonly content: MessageContent;
  readonly createdAt: UnixMs;
  readonly savedAt: UnixMs;
  readonly sourceAvailable: boolean;
}
export interface ChatView {
  readonly self: PublicUser;
  readonly role?: SessionRole;
  readonly room: { readonly id: RoomId; readonly title: string; readonly epochId: EpochId };
  readonly connection: ConnectionView;
  readonly history: HistoryWindow;
  readonly members: readonly PublicUser[];
  readonly typing: TypingView;
  readonly timeline: TimelineView;
  readonly composer: ComposerView;
  readonly search: SearchView;
  readonly preferences: LocalPreferences;
  readonly sound: SoundView;
  readonly notices: readonly NoticeView[];
  readonly pinned?: { readonly message: MessageView | null; readonly canManage: boolean; readonly pending: boolean; readonly sourceAvailable?: boolean };
  readonly bookmarks?: { readonly open: boolean; readonly items: readonly BookmarkView[] };
  readonly activity?: readonly { readonly id: string; readonly displayName: string; readonly kind: "joined" | "left" | "returned" }[];
}
export interface JoinView {
  readonly displayName: string;
  readonly adminPassword?: string;
  readonly restoreAvailable?: boolean;
  readonly useSavedIdentity?: boolean;
  readonly phase: "idle" | "submitting" | "error";
  readonly error: string | null;
}
export type AppView =
  | { readonly screen: "join"; readonly join: JoinView }
  | { readonly screen: "chat"; readonly chat: ChatView };

export type CopyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "denied" | "unavailable" | "failed" };
export interface ChatCallbacks {
  readonly onRetryConnection: () => void;
  readonly onLeaveRoom: () => void;
  readonly onReturnToJoin: () => void;
  readonly onDraftIntent: (intent: DraftIntent) => void;
  readonly onSubmit: (intent: SubmitIntent) => void;
  /** Returns whether the UI should call event.preventDefault(). */
  readonly onComposerKey: (input: ComposerKeyInput) => boolean;
  readonly onCompositionChange: (active: boolean) => void;
  readonly onComposerFocusChange: (focused: boolean) => void;
  readonly onReply: (messageId: MessageId) => void;
  readonly onSetReaction: (messageId: MessageId, emoji: ReactionEmoji, active: boolean) => void;
  readonly onRetryMessage: (operationId: OperationId) => void;
  /** Must preserve existing draft; ask before replacing non-empty content. */
  readonly onRestoreToComposer: (operationId: OperationId) => void;
  readonly onCopyCode: (source: string) => Promise<CopyResult>;
  readonly onJumpToMessage: (messageId: MessageId, reason: "quote" | "search") => void;
  readonly onJumpToLatest: () => void;
  readonly onReturnToReadingPosition: () => void;
  readonly onOpenSearch: () => void;
  readonly onCloseSearch: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRetrySearch: () => void;
  /** Invoke directly in the click handler so the audio service sees the user gesture. */
  readonly onSoundModeChange: (mode: LocalPreferences["soundMode"]) => void;
  readonly onPreviewSound: () => void;
  readonly onShortcutChange: (shortcut: LocalPreferences["textSendShortcut"]) => void;
  readonly onShareTypingChange: (enabled: boolean) => void;
  readonly onDismissNotice: (id: string) => void;
  readonly onSetPin: (messageId: MessageId | null) => void;
  readonly onToggleExpanded: (key: RenderKey) => void;
  readonly onReadingSizeChange: (size: ReadingSize) => void;
  readonly onMemberSoundsChange: (enabled: boolean) => void;
  readonly onToggleBookmark: (messageId: MessageId) => void;
  readonly onOpenBookmarks: () => void;
  readonly onCloseBookmarks: () => void;
  readonly onRemoveBookmark: (id: string) => void;
  readonly onClearBookmarks: () => void;
  readonly onJumpToBookmark: (id: string) => void;
}
/**
 * Presentation renders one scrolling message viewport. Application code owns measurement,
 * anchors and scroll writes. No scrollIntoView / automatic scrolling in UI components.
 * rowRef(key) must return a cached stable ref callback, not a fresh one every render.
 */
export interface TimelineDomBindings {
  readonly viewportRef: (node: HTMLDivElement | null) => void;
  readonly rowRef: (key: RenderKey) => (node: HTMLElement | null) => void;
  readonly onScroll: () => void;
}
export interface ComposerDomBindings {
  readonly textareaRef: (node: HTMLTextAreaElement | null) => void;
}
export interface JoinScreenProps {
  readonly view: JoinView;
  readonly onDisplayNameChange: (value: string) => void;
  readonly onAdminPasswordChange?: (value: string) => void;
  readonly onUseSavedIdentityChange?: (enabled: boolean) => void;
  readonly onSubmit: () => void;
}
export interface ChatScreenProps {
  readonly view: ChatView;
  readonly callbacks: ChatCallbacks;
  readonly timelineDom: TimelineDomBindings;
  readonly composerDom: ComposerDomBindings;
}
export interface HeaderProps {
  readonly role?: SessionRole;
  readonly roomTitle: string;
  readonly self: PublicUser;
  readonly memberCount: number;
  readonly connection: ConnectionView;
  readonly sound: SoundView;
  readonly onOpenSearch: () => void;
  readonly onSoundModeChange: ChatCallbacks["onSoundModeChange"];
  readonly onLeaveRoom: () => void;
}
export interface MessageListProps {
  readonly view: TimelineView;
  readonly dom: TimelineDomBindings;
  readonly callbacks: Pick<ChatCallbacks,
    "onReply" | "onSetReaction" | "onRetryMessage" | "onRestoreToComposer" |
    "onCopyCode" | "onJumpToMessage" | "onJumpToLatest" | "onReturnToReadingPosition" |
    "onToggleExpanded" | "onToggleBookmark" | "onSetPin">;
}
export interface MessageRowProps {
  readonly view: MessageView;
  readonly registerNode: (node: HTMLElement | null) => void;
  readonly callbacks: MessageListProps["callbacks"];
}
export interface CodeBlockProps {
  readonly source: string;
  readonly language: CodeLanguage;
  readonly matches: readonly HighlightRange[];
  readonly onCopy: () => Promise<CopyResult>;
}
export interface ReactionBarProps {
  readonly reactions: readonly ReactionView[];
  readonly enabled: boolean;
  readonly onSet: (emoji: ReactionEmoji, active: boolean) => void;
}
export interface QuotePreviewProps { readonly view: QuoteView; readonly onNavigate: () => void }
export interface TypingIndicatorProps { readonly view: TypingView }
export interface ConnectionBannerProps {
  readonly view: ConnectionView;
  readonly onRetry: () => void;
  readonly onReturnToJoin: () => void;
}
export interface SearchPanelProps {
  readonly view: SearchView;
  readonly history: HistoryWindow;
  readonly onQueryChange: (query: string) => void;
  readonly onSelectResult: (messageId: MessageId) => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}
export interface ComposerProps {
  readonly view: ComposerView;
  readonly dom: ComposerDomBindings;
  readonly callbacks: Pick<ChatCallbacks,
    "onDraftIntent" | "onSubmit" | "onComposerKey" |
    "onCompositionChange" | "onComposerFocusChange" | "onShortcutChange">;
}
export interface PreferencesProps {
  readonly preferences: LocalPreferences;
  readonly sound: SoundView;
  readonly callbacks: Pick<ChatCallbacks,
    "onSoundModeChange" | "onPreviewSound" | "onShortcutChange" | "onShareTypingChange" |
    "onReadingSizeChange" | "onMemberSoundsChange">;
}
export interface UnreadButtonProps {
  readonly count: number;
  readonly visible: boolean;
  readonly onActivate: () => void;
}
export const messageRenderKey = (
  message: Pick<ChatMessage, "author" | "clientOperationId">,
): RenderKey => `message:${message.author.id}:${message.clientOperationId}`;

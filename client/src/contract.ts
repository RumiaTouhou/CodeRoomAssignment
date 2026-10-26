/** Shared presentation types, constants and pure helpers. */
export type {
  RenderKey,
  ConnectionView,
  LocalPreferences,
  BookmarkView,
  SoundView,
  ReplyTarget,
  ComposerDraft,
  QuoteView,
  ComposerView,
  DraftIntent,
  SubmitIntent,
  ComposerKeyInput,
  DeliveryView,
  ReactionView,
  MessageView,
  TimelineItem,
  TimelineView,
  SearchView,
  TypingView,
  NoticeView,
  ChatView,
  JoinView,
  AppView,
  CopyResult,
  ChatCallbacks,
  TimelineDomBindings,
  ComposerDomBindings,
  JoinScreenProps,
  ChatScreenProps,
  HeaderProps,
  MessageListProps,
  MessageRowProps,
  CodeBlockProps,
  ReactionBarProps,
  QuotePreviewProps,
  TypingIndicatorProps,
  ConnectionBannerProps,
  SearchPanelProps,
  ComposerProps,
  PreferencesProps,
  UnreadButtonProps,
} from "../../shared/ui.js";
export { messageRenderKey } from "../../shared/ui.js";

export type {
  PublicUser,
  MessageContent,
  HistoryWindow,
  ReplyReference,
  UnixMs,
  MessageId,
  OperationId,
} from "../../shared/domain.js";

export type { HighlightRange, SearchResponse, SearchHit } from "../../shared/http.js";
export type { Problem } from "../../shared/errors.js";

export type { CodeLanguage, ReactionEmoji } from "../../shared/limits.js";
export { CODE_LANGUAGES, REACTION_EMOJIS, LIMITS } from "../../shared/limits.js";

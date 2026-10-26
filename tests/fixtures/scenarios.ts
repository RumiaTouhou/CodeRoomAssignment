import type { ChatMessage, PublicUser, RoomSnapshot } from "../../shared/domain.js";
import { LIMITS, REACTION_EMOJIS } from "../../shared/limits.js";
import { messageRenderKey } from "../../shared/ui.js";
import type { AppView, ChatView, ComposerDraft, MessageView, TimelineItem } from "../../shared/ui.js";
import { utf8Bytes } from "../../shared/validation.js";
import {
  ALICE, BOB, SAMPLE_EPOCH, SAMPLE_MESSAGES, SAMPLE_NOW, SAMPLE_SEARCH, SAMPLE_SNAPSHOT,
  RAW_CODE, fixtureId, snapshotFor,
} from "./messages.js";

export interface ScenarioCase {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly view: AppView;
}
export const EMPTY_DRAFT: ComposerDraft = {
  schemaVersion: 1, revision: 0, mode: "text", textBuffer: "",
  codeBuffer: { source: "", language: "plaintext" }, replyTarget: null,
};

export function scenarioChat(snapshot = SAMPLE_SNAPSHOT, self: PublicUser = ALICE): ChatView {
  const messageIds = new Set(snapshot.messages.map((message) => message.id));
  const items: TimelineItem[] = snapshot.messages.map((message, index) => {
    const previous = snapshot.messages[index - 1];
    const grouping = previous && previous.author.id === message.author.id &&
      previous.content.kind === "text" && message.content.kind === "text" &&
      previous.reply === null && message.reply === null &&
      message.createdAt - previous.createdAt <= LIMITS.groupWindowMs ? "continuation" : "start";
    const view: MessageView = {
      key: messageRenderKey(message), identity: { kind: "canonical", messageId: message.id, sequence: message.sequence },
      author: message.author, isMine: message.author.id === self.id, createdAt: message.createdAt,
      content: message.content, delivery: { phase: message.author.id === self.id ? "confirmed" : "incoming" },
      quote: message.reply ? { ...message.reply, availability: messageIds.has(message.reply.messageId) ? "available" : "expired" } : null,
      reactions: REACTION_EMOJIS.map((emoji) => {
        const ids = message.reactions.find((reaction) => reaction.emoji === emoji)?.userIds ?? [];
        return { emoji, count: ids.length, reactedByMe: ids.includes(self.id), pending: false, enabled: true };
      }),
      grouping, actions: { canReply: true, canReact: true, canRestoreToComposer: false },
      highlighted: false, searchMatches: [],
    };
    return { type: "message", key: view.key, message: view };
  });
  return {
    self, room: { id: "lobby", title: "CodeRoom · Engineering Lobby", epochId: snapshot.epochId },
    connection: { phase: "ready" }, history: snapshot.history, members: snapshot.presence.members,
    typing: { users: [] },
    timeline: { items, unseenIncomingCount: 0, atBottom: true, navigationMode: "following", canReturnToReadingPosition: false, highlightedMessageId: null },
    composer: {
      draft: EMPTY_DRAFT, replyPreview: null, canSubmit: false, disabledReason: "empty",
      bodyUtf8Bytes: 0, bodyLimitUtf8Bytes: LIMITS.messageBodyUtf8Bytes,
      isComposing: false, draftStorage: "available", shortcut: "enter", error: null,
    },
    search: { phase: "closed", query: "" },
    preferences: { schemaVersion: 1, soundMode: "off", textSendShortcut: "enter", shareTyping: true },
    sound: { mode: "off", playback: "not-enabled" }, notices: [],
  };
}
const base = scenarioChat();
const chat = (id: string, title: string, purpose: string, view: ChatView = base): ScenarioCase =>
  ({ id, title, purpose, view: { screen: "chat", chat: view } });
const draftText = "This unsent text is restored after a refresh.";
const filledDraft = { ...EMPTY_DRAFT, revision: 3, textBuffer: draftText };
const localRow = (delivery: MessageView["delivery"]): TimelineItem => {
  const operationId = fixtureId(9_001);
  const key = messageRenderKey({ author: ALICE, clientOperationId: operationId });
  return {
    type: "message", key,
    message: {
      key, identity: { kind: "outbox", operationId }, author: ALICE, isMine: true,
      createdAt: SAMPLE_NOW, content: { kind: "text", text: "This message requires server confirmation." }, delivery,
      quote: null, reactions: [], grouping: "start",
      actions: { canReply: false, canReact: false, canRestoreToComposer: delivery.phase !== "sending" },
      highlighted: false, searchMatches: [],
    },
  };
};
const withLocal = (delivery: MessageView["delivery"]): ChatView => ({
  ...base, timeline: { ...base.timeline, items: [...base.timeline.items, localRow(delivery)] },
});
const longCodeMessage: ChatMessage = {
  ...SAMPLE_MESSAGES[2]!,
  content: { kind: "code", source: RAW_CODE + "// " + "long-token-".repeat(50), language: "typescript" },
};
const longCodeSnapshot = snapshotFor(SAMPLE_MESSAGES.map((m) => m.id === longCodeMessage.id ? longCodeMessage : m), 10);
const prunedSnapshot: RoomSnapshot = snapshotFor(SAMPLE_MESSAGES.slice(3), 10);
const scenarioDefinitions: readonly ScenarioCase[] = [
  { id: "join-idle", title: "Join room", purpose: "Form and keyboard controls", view: { screen: "join", join: { displayName: "", phase: "idle", error: null } } },
  { id: "join-loading", title: "Joining room", purpose: "Duplicate submissions are disabled", view: { screen: "join", join: { displayName: "Alice", phase: "submitting", error: null } } },
  { id: "join-error", title: "Join failed", purpose: "The name remains visible after an error", view: { screen: "join", join: { displayName: "Alice", phase: "error", error: "Connection unavailable. Try again." } } },
  chat("conversation", "Conversation", "Text, code, reactions and quotes"),
  chat("bob-perspective", "Bob perspective", "Identity-specific ownership and membership", scenarioChat(SAMPLE_SNAPSHOT, BOB)),
  chat("empty-room", "Empty room", "An empty retained window", scenarioChat(snapshotFor([], 0))),
  chat("typing", "Typing", "Stable typing indicator space", { ...base, typing: { users: [BOB] } }),
  chat("new-messages", "New messages", "Reading position and unread count", {
    ...base, timeline: { ...base.timeline, atBottom: false, navigationMode: "reading", unseenIncomingCount: 3 },
  }),
  chat("code-overflow", "Code overflow", "Long code remains inside the message card", scenarioChat(longCodeSnapshot)),
  chat("search-results", "Search results", "Search snippets, ranges and navigation", {
    ...base, search: { phase: "results", query: "ACK", response: SAMPLE_SEARCH, mayBeStale: false },
    timeline: { ...base.timeline, atBottom: false, navigationMode: "search", canReturnToReadingPosition: true, highlightedMessageId: SAMPLE_SEARCH.results[0]!.messageId },
  }),
  chat("search-loading", "Search loading", "Pending search does not show stale results", { ...base, search: { phase: "loading", query: "ACK" } }),
  chat("search-empty", "Search empty", "No matches within the retained window", {
    ...base, search: { phase: "empty", query: "zz_no_match", response: { ...SAMPLE_SEARCH, query: "zz_no_match", totalMatches: 0, truncated: false, results: [] } },
  }),
  chat("search-error", "Search error", "Search failure retains the query", { ...base, search: { phase: "error", query: "ACK", message: "Search is unavailable. Try again.", retryable: true } }),
  chat("reconnecting", "Reconnecting", "Connection state differs from delivery state", {
    ...base, connection: { phase: "reconnecting", attempt: 2, nextAttemptAt: SAMPLE_NOW + 2_000 },
    composer: { ...base.composer, disabledReason: "offline" },
  }),
  chat("offline-draft", "Offline draft", "Editing without automatic offline delivery", {
    ...base, connection: { phase: "offline", canRetry: true },
    composer: { ...base.composer, draft: filledDraft, bodyUtf8Bytes: utf8Bytes(draftText), disabledReason: "offline" },
  }),
  chat("sending", "Sending", "Acceptance remains pending", withLocal({ phase: "sending" })),
  chat("unknown", "Unknown", "Retry preserves operation identity", withLocal({ phase: "unknown", canRetry: true, reason: "timeout" })),
  chat("rejected", "Rejected", "Rejection provides a recovery action", withLocal({ phase: "rejected", error: { code: "CONTENT_TOO_LARGE", message: "Content exceeds the allowed size.", retryable: false, outcome: "not-applied" } })),
  chat("accepted-expired", "Accepted expired", "Accepted content is outside retained history", withLocal({ phase: "accepted-outside-history" })),
  chat("reply-expired", "Reply expired", "Expired quotes preserve their summary", scenarioChat(prunedSnapshot)),
  chat("storage-unavailable", "Storage unavailable", "Storage failure leaves conversation usable", {
    ...base, composer: { ...base.composer, draftStorage: "unavailable" },
    notices: [{ id: "storage", severity: "warning", message: "Text cannot be saved in this browser. Keep the tab open until sending.", dismissible: true }],
  }),
  chat("sound-blocked", "Sound blocked", "Saved preference differs from playback capability", {
    ...base, preferences: { ...base.preferences, soundMode: "incoming" }, sound: { mode: "incoming", playback: "blocked" },
  }),
  chat("session-replaced", "Session replaced", "Terminal takeover stops reconnecting", {
    ...base, connection: { phase: "ended", reason: "replaced" },
    composer: { ...base.composer, disabledReason: "session-ended" },
  }),
  chat("code-composer", "Code composer", "Enter inserts a newline and modifier Enter sends", {
    ...base, composer: {
      ...base.composer, draft: { ...EMPTY_DRAFT, revision: 1, mode: "code", codeBuffer: { source: RAW_CODE, language: "typescript" } },
      bodyUtf8Bytes: utf8Bytes(RAW_CODE), canSubmit: true, disabledReason: null,
    },
  }),
];

export const SAMPLE_SCENARIOS: readonly ScenarioCase[] = scenarioDefinitions.map((scenario) => {
  if (scenario.view.screen !== "chat") return scenario;
  const view = scenario.view.chat;
  const ready = view.connection.phase === "ready";
  const items = view.timeline.items.map((item): TimelineItem => {
    if (item.type !== "message") return item;
    const target = item.message.identity.kind === "canonical" ? item.message.identity.messageId : null;
    const hit = view.search.phase === "results" ? view.search.response.results.find((r) => r.messageId === target) : undefined;
    return {
      ...item,
      message: {
        ...item.message,
        highlighted: target !== null && target === view.timeline.highlightedMessageId,
        searchMatches: hit?.matches ?? [],
        actions: { ...item.message.actions, canReact: ready && item.message.actions.canReact },
        reactions: item.message.reactions.map((reaction) => ({ ...reaction, enabled: ready && reaction.enabled })),
      },
    };
  });
  return { ...scenario, view: { screen: "chat", chat: { ...view, timeline: { ...view.timeline, items } } } };
});
export const SAMPLE_SCENARIO_BY_ID: ReadonlyMap<string, ScenarioCase> = new Map(SAMPLE_SCENARIOS.map((s) => [s.id, s]));
export const SAMPLE_METADATA = { contractVersion: "1.0.0", epochId: SAMPLE_EPOCH, generatedWithRandomness: false } as const;

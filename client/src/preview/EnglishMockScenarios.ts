import { projectPreviewComposer } from "./previewModel.js";
/** Deterministic English scenarios for component development. */
import type { ChatMessage, PublicUser } from "../../../shared/domain.js";
import type { SearchResponse } from "../../../shared/http.js";
import { LIMITS, REACTION_EMOJIS } from "../../../shared/limits.js";
import { messageRenderKey } from "../../../shared/ui.js";
import type {
  AppView,
  ChatView,
  ComposerDraft,
  MessageView,
  TimelineItem,
} from "../../../shared/ui.js";
import { utf8Bytes } from "../../../shared/validation.js";

export interface PreviewScenario {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly view: AppView;
}

/* Shared scenario data */

const fixtureId = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const PREVIEW_EPOCH = fixtureId(0x1000);
export const PREVIEW_NOW = Date.parse("2026-10-21T10:00:00.000Z");

export const ALICE: PublicUser = { id: fixtureId(1), displayName: "Alice", avatarSeed: "alice" };
export const BOB: PublicUser = { id: fixtureId(2), displayName: "Bob", avatarSeed: "bob" };
export const CHEN: PublicUser = { id: fixtureId(3), displayName: "Chen", avatarSeed: "chen" };
export const PREVIEW_USERS = [ALICE, BOB, CHEN] as const;

export const ROOM_TITLE = "CodeRoom · Engineering Lobby";

export const RAW_CODE =
  'export function preview(value: string) {\n\tconst literal = "**do not format**";\n\tconst html = "<div>plain text</div>";\n\treturn { value, literal, html };\n}\n';

const makeMessage = (
  sequence: number,
  author: PublicUser,
  content: ChatMessage["content"],
  reply: ChatMessage["reply"] = null,
): ChatMessage => ({
  id: fixtureId(100 + sequence),
  roomId: "lobby",
  epochId: PREVIEW_EPOCH,
  clientOperationId: fixtureId(200 + sequence),
  author,
  sequence,
  createdAt: PREVIEW_NOW - (9 - sequence) * 20_000,
  content,
  reply,
  reactions: [],
  mutationRevision: sequence,
});

const m1 = makeMessage(1, ALICE, {
  kind: "text",
  text: "First, watch the ACK timeout: no confirmation does not prove the server never received it.",
});
const m2 = makeMessage(2, BOB, {
  kind: "text",
  text: "Plain text with **asterisks** should stay literal — never auto-formatted into bold.",
});
const m3 = makeMessage(3, ALICE, { kind: "code", source: RAW_CODE, language: "typescript" });
const m4 = makeMessage(
  4,
  BOB,
  {
    kind: "text",
    text: "Copied it. Indentation and asterisks survived — I’m replying to that exact snippet.",
  },
  { messageId: m3.id, author: ALICE, kind: "code", previewText: "export function preview(value: string) {" },
);
const m5 = makeMessage(5, ALICE, { kind: "text", text: "Next up: search and reading position." });
const m6 = makeMessage(6, ALICE, {
  kind: "text",
  text: "Searching for ACK brings back the earlier discussion context.",
});
const m7 = makeMessage(7, ALICE, {
  kind: "text",
  text: "New arrivals shouldn’t yank you away from the message you’re reading.",
});
const m8 = makeMessage(8, CHEN, {
  kind: "text",
  text:
    'Special content stays plain text: <script>alert("not executed")</script>. Hi there 👩🏽‍💻\n' +
    "A very long identifier: " +
    "long_identifier_".repeat(15),
});

export const PREVIEW_MESSAGES: readonly ChatMessage[] = [
  m1,
  m2,
  { ...m3, reactions: [{ emoji: "✅", userIds: [BOB.id, CHEN.id] }], mutationRevision: 9 },
  m4,
  m5,
  m6,
  m7,
  { ...m8, reactions: [{ emoji: "👍", userIds: [ALICE.id] }], mutationRevision: 10 },
];

const historyFor = (messages: readonly ChatMessage[]) => ({
  retainedCount: messages.length,
  limit: LIMITS.historyMessages,
  serializedBytes: utf8Bytes(JSON.stringify(messages)),
  maxSerializedBytes: LIMITS.historyJsonUtf8Bytes,
  oldestSequence: messages[0]?.sequence ?? null,
  newestSequence: messages.at(-1)?.sequence ?? null,
  persistence: "memory-until-server-restart" as const,
});

const PREVIEW_HISTORY = historyFor(PREVIEW_MESSAGES);

export const PREVIEW_SEARCH: SearchResponse = {
  epochId: PREVIEW_EPOCH,
  roomId: "lobby",
  query: "ACK",
  asOfRevision: 10,
  searchedAt: PREVIEW_NOW,
  history: PREVIEW_HISTORY,
  totalMatches: 2,
  truncated: false,
  results: [m6, m1].map((message) => {
    const snippet = message.content.kind === "text" ? message.content.text : message.content.source;
    const start = snippet.indexOf("ACK");
    return {
      messageId: message.id,
      sequence: message.sequence,
      author: message.author,
      createdAt: message.createdAt,
      kind: message.content.kind,
      snippet,
      matches: [{ start, end: start + 3 }],
    };
  }),
};

/* Chat view projection */

export const EMPTY_DRAFT: ComposerDraft = {
  schemaVersion: 1,
  revision: 0,
  mode: "text",
  textBuffer: "",
  codeBuffer: { source: "", language: "plaintext" },
  replyTarget: null,
};

export function makePreviewChat(
  messages: readonly ChatMessage[] = PREVIEW_MESSAGES,
  self: PublicUser = ALICE,
): ChatView {
  const messageIds = new Set(messages.map((message) => message.id));
  const rows: TimelineItem[] = messages.map((message, index) => {
    const previous = messages[index - 1];
    const grouping =
      previous &&
      previous.author.id === message.author.id &&
      previous.content.kind === "text" &&
      message.content.kind === "text" &&
      previous.reply === null &&
      message.reply === null &&
      message.createdAt - previous.createdAt <= LIMITS.groupWindowMs
        ? "continuation"
        : "start";
    const view: MessageView = {
      key: messageRenderKey(message),
      identity: { kind: "canonical", messageId: message.id, sequence: message.sequence },
      author: message.author,
      isMine: message.author.id === self.id,
      createdAt: message.createdAt,
      content: message.content,
      delivery: { phase: message.author.id === self.id ? "confirmed" : "incoming" },
      quote: message.reply
        ? {
            ...message.reply,
            availability: messageIds.has(message.reply.messageId) ? "available" : "expired",
          }
        : null,
      reactions: REACTION_EMOJIS.map((emoji) => {
        const ids = message.reactions.find((reaction) => reaction.emoji === emoji)?.userIds ?? [];
        return {
          emoji,
          count: ids.length,
          reactedByMe: ids.includes(self.id),
          pending: false,
          enabled: true,
        };
      }),
      grouping,
      actions: { canReply: true, canReact: true, canRestoreToComposer: false, canPin: false },
      fold: { collapsible: (message.content.kind === "text" ? message.content.text : message.content.source).split("\n").length > 12 || [...(message.content.kind === "text" ? message.content.text : message.content.source)].length > 1200, expanded: false },
      bookmarked: false,
      highlighted: false,
      searchMatches: [],
    };
    return { type: "message", key: view.key, message: view };
  });

  const items: TimelineItem[] =
    rows.length > 0
      ? [{ type: "date-separator", key: "date:today", label: "Today" }, ...rows]
      : rows;

  return {
    self,
    room: { id: "lobby", title: ROOM_TITLE, epochId: PREVIEW_EPOCH },
    connection: { phase: "ready" },
    history: historyFor(messages),
    members: PREVIEW_USERS,
    typing: { users: [] },
    timeline: {
      items,
      unseenIncomingCount: 0,
      atBottom: true,
      navigationMode: "following",
      canReturnToReadingPosition: false,
      highlightedMessageId: null,
    },
    composer: {
      draft: EMPTY_DRAFT,
      replyPreview: null,
      canSubmit: false,
      disabledReason: "empty",
      bodyUtf8Bytes: 0,
      bodyLimitUtf8Bytes: LIMITS.messageBodyUtf8Bytes,
      isComposing: false,
      draftStorage: "available",
      shortcut: "enter",
      error: null,
    },
    search: { phase: "closed", query: "" },
    preferences: { schemaVersion: 1, soundMode: "off", textSendShortcut: "enter", shareTyping: true, readingSize: "standard", memberSounds: true },
    sound: { mode: "off", playback: "not-enabled" },
    notices: [],
    pinned: { message: null, canManage: false, pending: false },
    bookmarks: { open: false, items: [] },
    activity: [],
  };
}

/* Scenario variants */

const base = makePreviewChat();
const chat = (id: string, title: string, purpose: string, view: ChatView = base): PreviewScenario => ({
  id,
  title,
  purpose,
  view: { screen: "chat", chat: view },
});

const draftText = "This draft hasn’t been sent yet — it should survive a refresh.";
const filledDraft = { ...EMPTY_DRAFT, revision: 3, textBuffer: draftText };

const localRow = (delivery: MessageView["delivery"]): TimelineItem => {
  const operationId = fixtureId(0x9001);
  const key = messageRenderKey({ author: ALICE, clientOperationId: operationId });
  return {
    type: "message",
    key,
    message: {
      key,
      identity: { kind: "outbox", operationId },
      author: ALICE,
      isMine: true,
      createdAt: PREVIEW_NOW,
      content: { kind: "text", text: "This message still needs a real server confirmation." },
      delivery,
      quote: null,
      reactions: [],
      grouping: "start",
      actions: { canReply: false, canReact: false, canRestoreToComposer: delivery.phase !== "sending" },
      highlighted: false,
      searchMatches: [],
    },
  };
};

const withLocal = (delivery: MessageView["delivery"]): ChatView => ({
  ...base,
  timeline: { ...base.timeline, items: [...base.timeline.items, localRow(delivery)] },
});

const longCodeMessage: ChatMessage = {
  ...PREVIEW_MESSAGES[2]!,
  content: {
    kind: "code",
    source: RAW_CODE + "// " + "long-token-".repeat(50),
    language: "typescript",
  },
};
const longCodeMessages = PREVIEW_MESSAGES.map((message) =>
  message.id === longCodeMessage.id ? longCodeMessage : message,
);
const prunedMessages = PREVIEW_MESSAGES.slice(3);

const withHistoryBoundary = (view: ChatView): ChatView => ({
  ...view,
  timeline: {
    ...view.timeline,
    items: [
      {
        type: "history-boundary",
        key: "history:start",
        label: "Earlier messages are no longer retained",
      },
      ...view.timeline.items,
    ],
  },
});

const firstMessage = base.timeline.items.find((item): item is Extract<TimelineItem, { type: "message" }> => item.type === "message")!.message;
const adminChat: ChatView = {
  ...base,
  role: "admin",
  pinned: { message: firstMessage, canManage: true, pending: false, sourceAvailable: true },
  timeline: { ...base.timeline, items: base.timeline.items.map(item => item.type !== "message" ? item : {
    ...item, message: { ...item.message, actions: { ...item.message.actions, canPin: true } },
  }) },
};
const foldedChat = makePreviewChat([
  makeMessage(1, BOB, { kind: "text", text: Array.from({ length: 20 }, (_, index) => `Line ${index + 1}: Plain text keeps **asterisks** and indentation intact.`).join("\n") }),
  makeMessage(2, ALICE, { kind: "code", language: "typescript", source: Array.from({ length: 22 }, (_, index) => `\tconst sample${index} = "literal";`).join("\n") }),
]);

const scenarioDefinitions: readonly PreviewScenario[] = [
  {
    id: "join-idle",
    title: "Join room",
    purpose: "Default form, keyboard flow and privacy note",
    view: { screen: "join", join: { displayName: "", phase: "idle", error: null } },
  },
  {
    id: "join-return",
    title: "Return or join fresh",
    purpose: "Saved identity is optional and independent of administrator authentication",
    view: { screen: "join", join: { displayName: "Alice", phase: "idle", error: null, restoreAvailable: true, useSavedIdentity: true } },
  },
  {
    id: "join-loading",
    title: "Joining…",
    purpose: "Submitting state disables duplicate submits",
    view: { screen: "join", join: { displayName: "Alice", phase: "submitting", error: null } },
  },
  {
    id: "join-error",
    title: "Join failed",
    purpose: "The error never eats the typed display name",
    view: {
      screen: "join",
      join: {
        displayName: "Alice",
        phase: "error",
        error: "Can’t reach the server right now. Check your connection and try again.",
      },
    },
  },
  chat("admin-room", "Admin controls", "Public pin and administrator actions", adminChat),
  chat("pinned-snapshot", "Pinned snapshot outside history", "Full pinned content remains available after history retention", {
    ...base, pinned: { message: firstMessage, canManage: false, pending: false, sourceAvailable: false },
  }),
  chat("folded-messages", "Long messages", "Controlled expansion preserves complete raw copy", foldedChat),
  chat("large-reading", "Larger reading size", "Text, code and composer scale together", { ...base, preferences: { ...base.preferences, readingSize: "larger" } }),
  chat("member-activity", "Member activity", "Quiet join, departure and return notices", { ...base, activity: [
    { id: "activity-1", displayName: "Bob", kind: "joined" },
    { id: "activity-2", displayName: "Chen", kind: "left" },
    { id: "activity-3", displayName: "Chen", kind: "returned" },
  ] }),
  chat("bookmarks", "Saved bookmarks", "Local snapshots remain readable when original messages expire", {
    ...base, bookmarks: { open: true, items: [
      { id: m3.id, author: ALICE, content: m3.content, createdAt: m3.createdAt, savedAt: PREVIEW_NOW, sourceAvailable: true },
      { id: "retained-snapshot", author: BOB, content: { kind: "text", text: "Saved notes remain available after room history expires.\n".repeat(24) }, createdAt: PREVIEW_NOW, savedAt: PREVIEW_NOW, sourceAvailable: false },
    ] },
  }),
  chat("conversation", "Everyday conversation", "Text, code, reactions, quotes and plain-text safety"),
  chat(
    "bob-perspective",
    "Bob’s perspective",
    "Same messages, different isMine / reactedByMe",
    makePreviewChat(PREVIEW_MESSAGES, BOB),
  ),
  chat("empty-room", "Empty room", "No fake welcome messages", makePreviewChat([])),
  chat("typing", "Typing indicator", "Fixed-height slot never pushes the message list", {
    ...base,
    typing: { users: [BOB] },
  }),
  chat("new-messages", "New messages while reading", "No auto-scroll; a pill offers the jump", {
    ...base,
    timeline: { ...base.timeline, atBottom: false, navigationMode: "reading", unseenIncomingCount: 3 },
  }),
  chat(
    "code-overflow",
    "Long code lines",
    "Only the code card scrolls horizontally",
    makePreviewChat(longCodeMessages),
  ),
  chat("search-results", "Search results", "Snippets, highlights, scope and jump-to-context", {
    ...base,
    search: { phase: "results", query: "ACK", response: PREVIEW_SEARCH, mayBeStale: false },
    timeline: {
      ...base.timeline,
      atBottom: false,
      navigationMode: "search",
      canReturnToReadingPosition: true,
      highlightedMessageId: PREVIEW_SEARCH.results[0]!.messageId,
    },
  }),
  chat("search-loading", "Search loading", "Old results never pose as a new query’s answer", {
    ...base,
    search: { phase: "loading", query: "ACK" },
  }),
  chat("search-empty", "No search results", "Scope stays explicit — retained history only", {
    ...base,
    search: {
      phase: "empty",
      query: "zz_no_match",
      response: { ...PREVIEW_SEARCH, query: "zz_no_match", totalMatches: 0, truncated: false, results: [] },
    },
  }),
  chat("search-error", "Search failed", "Query is preserved; retry is offered", {
    ...base,
    search: {
      phase: "error",
      query: "ACK",
      message: "Search is temporarily unavailable. Try again.",
      retryable: true,
    },
  }),
  chat("reconnecting", "Reconnecting", "Connection state is not a send result", {
    ...base,
    connection: { phase: "reconnecting", attempt: 2, nextAttemptAt: PREVIEW_NOW + 2_000 },
    composer: { ...base.composer, disabledReason: "offline" },
  }),
  chat("offline-draft", "Offline draft kept", "Editing stays possible; nothing is silently queued", {
    ...base,
    connection: { phase: "offline", canRetry: true },
    composer: {
      ...base.composer,
      draft: filledDraft,
      bodyUtf8Bytes: utf8Bytes(draftText),
      disabledReason: "offline",
    },
  }),
  chat("sending", "Sending…", "In flight — not delivered, not read", withLocal({ phase: "sending" })),
  chat(
    "unknown",
    "Send status unknown",
    "Manual retry with the same operationId",
    withLocal({ phase: "unknown", canRetry: true, reason: "timeout" }),
  ),
  chat(
    "rejected",
    "Rejected by server",
    "Honest failure copy with a recovery path",
    withLocal({
      phase: "rejected",
      error: {
        code: "CONTENT_TOO_LARGE",
        message: "Content exceeds the allowed size.",
        retryable: false,
        outcome: "not-applied",
      },
    }),
  ),
  chat(
    "accepted-expired",
    "Accepted outside history",
    "Never re-send the same message to force a duplicate",
    withLocal({ phase: "accepted-outside-history" }),
  ),
  chat(
    "reply-expired",
    "Expired quote",
    "Quote summary stays; navigation is disabled",
    withHistoryBoundary(makePreviewChat(prunedMessages)),
  ),
  chat("storage-unavailable", "Draft storage unavailable", "A storage failure never blocks chat", {
    ...base,
    composer: { ...base.composer, draftStorage: "unavailable" },
    notices: [
      {
        id: "storage",
        severity: "warning",
        message: "This browser can’t save drafts. Don’t close the tab before sending.",
        dismissible: true,
      },
    ],
  }),
  chat("sound-blocked", "Audio playback blocked", "A saved preference is not proof of playback", {
    ...base,
    preferences: { ...base.preferences, soundMode: "incoming" },
    sound: { mode: "incoming", playback: "blocked" },
  }),
  chat("session-replaced", "Session replaced", "Auto-reconnect stops; windows don’t fight", {
    ...base,
    connection: { phase: "ended", reason: "replaced" },
    composer: { ...base.composer, disabledReason: "session-ended" },
  }),
  chat("code-composer", "Code composer mode", "Enter adds a line; Ctrl/⌘+Enter sends", {
    ...base,
    composer: {
      ...base.composer,
      draft: {
        ...EMPTY_DRAFT,
        revision: 1,
        mode: "code",
        codeBuffer: { source: RAW_CODE, language: "typescript" },
      },
      bodyUtf8Bytes: utf8Bytes(RAW_CODE),
      canSubmit: true,
      disabledReason: null,
    },
  }),
  chat("reaction-pending", "Reaction awaiting confirmation", "Zero-count pending feedback; locked items cannot be activated", {
    ...base, timeline: { ...base.timeline, items: base.timeline.items.map((item) => item.type !== "message" ? item : {
      ...item, message: { ...item.message, reactions: item.message.reactions.map((r) => r.emoji === "👍" ? { ...r, count: 0, reactedByMe: false, pending: true } : r.emoji === "❤️" ? { ...r, enabled: false } : r) },
    }) },
  }),
  chat("reply-composer", "Reply in progress", "Controlled reply target and cancel action", {
    ...base, composer: { ...base.composer, draft: { ...filledDraft, replyTarget: { epochId: PREVIEW_EPOCH, messageId: m3.id } },
      replyPreview: { messageId: m3.id, author: ALICE, kind: "code", previewText: "export function preview(value: string) {", availability: "available" },
      bodyUtf8Bytes: utf8Bytes(draftText), canSubmit: true, disabledReason: null },
  }),
  chat("reply-composer-expired", "Expired reply in composer", "Summary remains readable after the target leaves history", {
    ...makePreviewChat(prunedMessages), composer: { ...base.composer, draft: { ...filledDraft, replyTarget: { epochId: PREVIEW_EPOCH, messageId: m3.id } },
      replyPreview: { messageId: m3.id, author: ALICE, kind: "code", previewText: "export function preview(value: string) {", availability: "expired" },
      bodyUtf8Bytes: utf8Bytes(draftText), canSubmit: true, disabledReason: null },
  }),
  chat("copy-denied", "Clipboard permission denied", "Copy reports failure honestly; code remains selectable"),
  chat("sound-unavailable", "Audio unavailable", "Incoming preference is distinct from playback capability", {
    ...base, preferences: { ...base.preferences, soundMode: "incoming" }, sound: { mode: "incoming", playback: "unavailable" },
  }),
  chat("sound-ready", "Audio preference ready", "Preview callback is separate from real message playback", {
    ...base, preferences: { ...base.preferences, soundMode: "incoming" }, sound: { mode: "incoming", playback: "ready" },
  }),
  chat("connecting", "Connecting", "Draft editing remains available while sending is locked", { ...base, connection: { phase: "connecting" } }),
  chat("synchronizing", "Synchronizing", "Sending waits for an authoritative room snapshot", { ...base, connection: { phase: "synchronizing" } }),
  chat("search-stale", "Search results may be stale", "Existing results remain clearly labeled", { ...base, search: { phase: "results", query: "ACK", response: PREVIEW_SEARCH, mayBeStale: true } }),
  chat("draft-too-large", "Draft exceeds byte limit", "Oversized input is preserved and sending is disabled", { ...base, composer: { ...base.composer, draft: { ...filledDraft, textBuffer: "Large draft. ".repeat(1500) } } }),
  chat("outbox-full", "Unconfirmed message limit", "The presentation follows the supplied outbox lock", { ...base, composer: { ...base.composer, draft: filledDraft, disabledReason: "outbox-full" } }),
  ...(["expired", "revoked", "server-restarted"] as const).map((reason) => chat(`session-${reason}`, `Session ${reason}`, "Terminal session state has an accessible recovery action", {
    ...base, connection: { phase: "ended", reason }, composer: { ...base.composer, disabledReason: "session-ended" },
  })),
];

/** Keep highlight and availability fields consistent. */
export const PREVIEW_SCENARIOS: readonly PreviewScenario[] = scenarioDefinitions.map((scenario) => {
  if (scenario.view.screen !== "chat") return scenario;
  const view = scenario.view.chat;
  const ready = view.connection.phase === "ready";
  const items = view.timeline.items.map((item): TimelineItem => {
    if (item.type !== "message") return item;
    const target = item.message.identity.kind === "canonical" ? item.message.identity.messageId : null;
    const hit =
      view.search.phase === "results"
        ? view.search.response.results.find((result) => result.messageId === target)
        : undefined;
    return {
      ...item,
      message: {
        ...item.message,
        highlighted: target !== null && target === view.timeline.highlightedMessageId,
        searchMatches: hit?.matches ?? [],
        actions: { ...item.message.actions, canReact: ready && item.message.actions.canReact },
        reactions: item.message.reactions.map((reaction) => ({
          ...reaction,
          enabled: ready && reaction.enabled,
        })),
      },
    };
  });
  return { ...scenario, view: { screen: "chat", chat: { ...view, composer: projectPreviewComposer(view.composer, view.composer.draft, view.preferences.textSendShortcut, view.connection), timeline: { ...view.timeline, items } } } };
});

export const PREVIEW_SCENARIO_BY_ID: ReadonlyMap<string, PreviewScenario> = new Map(
  PREVIEW_SCENARIOS.map((scenario) => [scenario.id, scenario]),
);

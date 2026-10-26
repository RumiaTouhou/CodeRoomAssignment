import type {
  ChatCallbacks,
  CopyResult,
  ComposerDomBindings,
  RenderKey,
  TimelineDomBindings,
} from "../../../shared/ui.js";

export type PreviewLog = (action: string) => void;

interface MockBindingOptions {
  readonly log: PreviewLog;
  readonly copyResult?: CopyResult;
  /** Current composer facts so the preview can apply the shortcut policy. */
  readonly getComposerFacts: () => {
    readonly shortcut: "enter" | "mod-enter";
    readonly mode: "text" | "code";
    readonly canSubmit: boolean;
  };
  /** Called when the shortcut policy decides a keystroke submits. */
  readonly onMockShortcutSubmit: () => void;
}

/** Preview callbacks record intents and apply local keyboard behavior. */
export function makeMockBindings({ log, getComposerFacts, onMockShortcutSubmit, copyResult }: MockBindingOptions): {
  callbacks: ChatCallbacks;
  timelineDom: TimelineDomBindings;
  composerDom: ComposerDomBindings;
} {
  const rowRefs = new Map<RenderKey, (node: HTMLElement | null) => void>();

  const callbacks: ChatCallbacks = {
    onRetryConnection: () => log("onRetryConnection()"),
    onLeaveRoom: () => log("onLeaveRoom()"),
    onReturnToJoin: () => log("onReturnToJoin()"),
    onDraftIntent: (intent) => log(`onDraftIntent(${intent.type})`),
    onSubmit: (intent) =>
      log(`onSubmit({ draftRevision: ${intent.draftRevision}, trigger: "${intent.trigger}" })`),
    onComposerKey: (input) => {
      if (input.isComposing || input.legacyKeyCode === 229 || input.altKey || input.key !== "Enter") return false;
      const facts = getComposerFacts();
      const mod = input.ctrlKey || input.metaKey;
      const sends =
        facts.mode === "code"
          ? mod && !input.shiftKey
          : facts.shortcut === "enter"
            ? !mod && !input.shiftKey && !input.altKey
            : mod && !input.shiftKey;
      if (!sends || !facts.canSubmit) return false;
      onMockShortcutSubmit();
      return true;
    },
    onCompositionChange: (active) => log(`onCompositionChange(${active})`),
    onComposerFocusChange: (focused) => log(`onComposerFocusChange(${focused})`),
    onReply: (messageId) => log(`onReply(${messageId.slice(-4)})`),
    onSetReaction: (messageId, emoji, active) =>
      log(`onSetReaction(…${messageId.slice(-4)}, ${emoji}, ${active})`),
    onRetryMessage: (operationId) => log(`onRetryMessage(…${operationId.slice(-4)})`),
    onRestoreToComposer: (operationId) => log(`onRestoreToComposer(…${operationId.slice(-4)})`),
    onCopyCode: async (source) => {
      if (copyResult) { log(`onCopyCode(${source.length} chars) — injected failure fixture`); return copyResult; }
      if (!navigator.clipboard?.writeText) { log("Clipboard unavailable"); return { ok: false, reason: "unavailable" }; }
      try { await navigator.clipboard.writeText(source); log("Raw code copied to clipboard"); return { ok: true }; }
      catch { log("Clipboard permission denied"); return { ok: false, reason: "denied" }; }
    },
    onJumpToMessage: (messageId, reason) => log(`onJumpToMessage(…${messageId.slice(-4)}, "${reason}")`),
    onJumpToLatest: () => log("onJumpToLatest()"),
    onReturnToReadingPosition: () => log("onReturnToReadingPosition()"),
    onOpenSearch: () => log("onOpenSearch()"),
    onCloseSearch: () => log("onCloseSearch()"),
    onSearchQueryChange: () => {},
    onRetrySearch: () => log("onRetrySearch()"),
    onSoundModeChange: () => {},
    onPreviewSound: () =>
      log("onPreviewSound() — preview action"),
    onShortcutChange: () => {},
    onShareTypingChange: () => {},
    onDismissNotice: (id) => log(`onDismissNotice("${id}")`),
    onSetPin: (id) => log(`onSetPin(${id ?? "none"})`),
    onToggleExpanded: (key) => log(`onToggleExpanded(${key})`),
    onReadingSizeChange: () => {},
    onMemberSoundsChange: () => {},
    onToggleBookmark: (id) => log(`onToggleBookmark(${id})`),
    onOpenBookmarks: () => log("onOpenBookmarks()"),
    onCloseBookmarks: () => log("onCloseBookmarks()"),
    onRemoveBookmark: (id) => log(`onRemoveBookmark(${id})`),
    onClearBookmarks: () => log("onClearBookmarks()"),
    onJumpToBookmark: (id) => log(`onJumpToBookmark(${id})`),
  };

  const timelineDom: TimelineDomBindings = {
    viewportRef: () => {},
    rowRef: (key) => {
      let cached = rowRefs.get(key);
      if (!cached) {
        cached = () => {};
        rowRefs.set(key, cached);
      }
      return cached;
    },
    onScroll: () => {},
  };

  const composerDom: ComposerDomBindings = { textareaRef: () => {} };

  return { callbacks, timelineDom, composerDom };
}

import { useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, Volume2 } from "lucide-react";
import type {
  AppView,
  BookmarkView,
  ChatCallbacks,
  ChatView,
  ComposerDraft,
  LocalPreferences,
  SearchView,
} from "../../../shared/ui.js";
import { projectPreviewComposer } from "./previewModel.js";
import { ChatScreen } from "../ui/ChatScreen.jsx";
import { JoinScreen } from "../ui/JoinScreen.jsx";
import { PREVIEW_SCENARIO_BY_ID, PREVIEW_SCENARIOS } from "./EnglishMockScenarios.js";
import { makeMockBindings } from "./MockCallbacks.js";
import { SoundAudition } from "./SoundAudition.jsx";

const DEFAULT_SCENARIO = "conversation";

const scenarioFromUrl = (): string => {
  const param = new URLSearchParams(window.location.search).get("scenario");
  return param !== null && PREVIEW_SCENARIO_BY_ID.has(param) ? param : DEFAULT_SCENARIO;
};

/** Scenario selection and local input overlays for the development preview. */
export function PreviewHost() {
  const [scenarioId, setScenarioId] = useState<string>(scenarioFromUrl);
  const [lastAction, setLastAction] = useState<string>("—");
  const [auditionOpen, setAuditionOpen] = useState(false);

  // Reset local controls when the scenario changes.
  const [draftOverlay, setDraftOverlay] = useState<ComposerDraft | null>(null);
  const [queryOverlay, setQueryOverlay] = useState<string | null>(null);
  const [prefsOverlay, setPrefsOverlay] = useState<LocalPreferences | null>(null);
  const [joinName, setJoinName] = useState<string | null>(null);
  const [useSavedIdentity, setUseSavedIdentity] = useState<boolean | null>(null);
  const [joinPassword, setJoinPassword] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const [bookmarkOverlay, setBookmarkOverlay] = useState<readonly BookmarkView[] | null>(null);
  const [bookmarksOpen, setBookmarksOpen] = useState<boolean | null>(null);
  const [pinId, setPinId] = useState<string | null | undefined>(undefined);
  const [searchOverlay, setSearchOverlay] = useState<SearchView | null>(null);

  useEffect(() => {
    setDraftOverlay(null);
    setQueryOverlay(null);
    setPrefsOverlay(null);
    setJoinName(null);
    setSearchOverlay(null);
    setJoinPassword(null);
    setUseSavedIdentity(null);
    setExpandedKeys(new Set());
    setBookmarkOverlay(null);
    setBookmarksOpen(null);
    setPinId(undefined);
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", scenarioId);
    window.history.replaceState(null, "", url);
  }, [scenarioId]);

  const scenario = PREVIEW_SCENARIO_BY_ID.get(scenarioId) ?? PREVIEW_SCENARIOS[0]!;

  const chatState = scenario.view.screen === "chat" ? scenario.view.chat : null;
  const projectedComposer = chatState ? projectPreviewComposer(chatState.composer,
    draftOverlay ?? chatState.composer.draft,
    prefsOverlay?.textSendShortcut ?? chatState.preferences.textSendShortcut,
    chatState.connection) : null;
  const factsRef = useRef({ shortcut: "enter" as LocalPreferences["textSendShortcut"], mode: "text" as ComposerDraft["mode"], canSubmit: false });
  factsRef.current = { shortcut: projectedComposer?.shortcut ?? "enter", mode: projectedComposer?.draft.mode ?? "text", canSubmit: projectedComposer?.canSubmit ?? false };
  const copyDenied = scenarioId === "copy-denied";
  const bindings = useMemo(() => makeMockBindings({
    log: setLastAction, getComposerFacts: () => factsRef.current,
    onMockShortcutSubmit: () => setLastAction('onSubmit({ trigger: "shortcut" }) — preview intent only'),
    ...(copyDenied ? { copyResult: { ok: false as const, reason: "denied" as const } } : {}),
  }), [scenarioId, copyDenied]);

  const log = setLastAction;

  const callbacks: ChatCallbacks = {
    ...bindings.callbacks,
    onDraftIntent: (intent) => {
      log(`onDraftIntent(${intent.type})`);
      const chat = scenario.view.screen === "chat" ? scenario.view.chat : null;
      const current = draftOverlay ?? chat?.composer.draft;
      if (!current) return;
      const next: ComposerDraft = { ...current, revision: current.revision + 1 };
      setDraftOverlay(
        intent.type === "text.changed"
          ? { ...next, textBuffer: intent.value }
          : intent.type === "code.changed"
            ? { ...next, codeBuffer: { ...next.codeBuffer, source: intent.value } }
            : intent.type === "mode.changed"
              ? { ...next, mode: intent.value }
              : intent.type === "language.changed"
                ? { ...next, codeBuffer: { ...next.codeBuffer, language: intent.value } }
                : { ...next, replyTarget: null },
      );
    },
    onSearchQueryChange: (query) => {
      log(`onSearchQueryChange("${query}")`);
      setQueryOverlay(query);
    },
    onOpenSearch: () => {
      log("onOpenSearch()");
      setBookmarksOpen(false);
      setSearchOverlay({ phase: "idle", query: queryOverlay ?? searchOverlay?.query ?? chatState?.search.query ?? "" });
    },
    onCloseSearch: () => {
      log("onCloseSearch()");
      const chat = scenario.view.screen === "chat" ? scenario.view.chat : null;
      setSearchOverlay({ phase: "closed", query: queryOverlay ?? searchOverlay?.query ?? chat?.search.query ?? "" });
    },
    onSoundModeChange: (mode) => {
      log(`onSoundModeChange("${mode}")`);
      const chat = scenario.view.screen === "chat" ? scenario.view.chat : null;
      if (chat) setPrefsOverlay({ ...(prefsOverlay ?? chat.preferences), soundMode: mode });
    },
    onShortcutChange: (shortcut) => {
      log(`onShortcutChange("${shortcut}")`);
      const chat = scenario.view.screen === "chat" ? scenario.view.chat : null;
      if (chat) setPrefsOverlay({ ...(prefsOverlay ?? chat.preferences), textSendShortcut: shortcut });
    },
    onReadingSizeChange: (size) => {
      if (chatState) setPrefsOverlay({ ...(prefsOverlay ?? chatState.preferences), readingSize: size });
    },
    onMemberSoundsChange: (enabled) => {
      if (chatState) setPrefsOverlay({ ...(prefsOverlay ?? chatState.preferences), memberSounds: enabled });
    },
    onToggleExpanded: (key) => setExpandedKeys(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    }),
    onSetPin: (id) => { setPinId(id); log(`onSetPin(${id ?? "none"})`); },
    onOpenBookmarks: () => {
      setBookmarksOpen(true);
      setSearchOverlay({ phase: "closed", query: queryOverlay ?? "" });
    },
    onCloseBookmarks: () => setBookmarksOpen(false),
    onToggleBookmark: (id) => {
      if (!chatState) return;
      const current = bookmarkOverlay ?? chatState.bookmarks?.items ?? [];
      if (current.some(item => item.id === id)) { setBookmarkOverlay(current.filter(item => item.id !== id)); return; }
      const row = chatState.timeline.items.find(item => item.type === "message" && item.message.identity.kind === "canonical" && item.message.identity.messageId === id);
      if (!row || row.type !== "message") return;
      const message = row.message;
      setBookmarkOverlay([...current, { id, author: message.author, content: message.content, createdAt: message.createdAt, savedAt: Date.now(), sourceAvailable: true }]);
    },
    onRemoveBookmark: (id) => setBookmarkOverlay((bookmarkOverlay ?? chatState?.bookmarks?.items ?? []).filter(item => item.id !== id)),
    onClearBookmarks: () => setBookmarkOverlay([]),
    onJumpToBookmark: (id) => { setBookmarksOpen(false); log(`onJumpToBookmark(${id})`); },
    onShareTypingChange: (enabled) => {
      log(`onShareTypingChange(${enabled})`);
      const chat = scenario.view.screen === "chat" ? scenario.view.chat : null;
      if (chat) setPrefsOverlay({ ...(prefsOverlay ?? chat.preferences), shareTyping: enabled });
    },
  };

  // Apply local control values to the selected scenario.
  const view: AppView = useMemo(() => {
    if (scenario.view.screen === "join") {
      const join = scenario.view.join;
      return {
        screen: "join",
        join: { ...join, displayName: joinName ?? join.displayName, adminPassword: joinPassword ?? join.adminPassword ?? "", useSavedIdentity: useSavedIdentity ?? join.useSavedIdentity ?? true },
      };
    }
    const chat: ChatView = scenario.view.chat;
    const composer = projectPreviewComposer(chat.composer, draftOverlay ?? chat.composer.draft,
      prefsOverlay?.textSendShortcut ?? chat.preferences.textSendShortcut, chat.connection);
    let search: SearchView = searchOverlay ?? chat.search;
    if (queryOverlay !== null && search.phase !== "closed" && queryOverlay !== search.query) {
      search = { phase: "idle", query: queryOverlay };
    }
    const preferences = prefsOverlay ?? chat.preferences;
    const sound = { ...chat.sound, mode: preferences.soundMode };
    const bookmarks = { open: bookmarksOpen ?? chat.bookmarks?.open ?? false, items: bookmarkOverlay ?? chat.bookmarks?.items ?? [] };
    const items = chat.timeline.items.map(item => {
      if (item.type !== "message") return item;
      const message = item.message;
      return { ...item, message: { ...message,
        fold: { collapsible: message.fold?.collapsible ?? false, expanded: expandedKeys.has(message.key) },
        bookmarked: message.identity.kind === "canonical" && bookmarks.items.some(bookmark => message.identity.kind === "canonical" && bookmark.id === message.identity.messageId),
      } };
    });
    const selectedPin = items.find(item => item.type === "message" && item.message.identity.kind === "canonical" && item.message.identity.messageId === pinId);
    const pinned = { ...chat.pinned, canManage: chat.pinned?.canManage ?? false, pending: false,
      message: pinId === undefined ? chat.pinned?.message ?? null : selectedPin?.type === "message" ? selectedPin.message : null };
    return { screen: "chat", chat: { ...chat, composer, search, preferences, sound, bookmarks, pinned, timeline: { ...chat.timeline, items } } };
  }, [scenario, draftOverlay, queryOverlay, prefsOverlay, joinName, joinPassword, useSavedIdentity, searchOverlay, expandedKeys, bookmarkOverlay, bookmarksOpen, pinId]);

  return (
    <div className="flex h-dvh flex-col bg-ink">
      {/* Scenario controls */}
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 bg-ink px-3 py-1 text-ink-invert">
        <span className="cr-label flex items-center gap-1.5 text-[9.5px] text-ink-invert/70">
          <FlaskConical className="h-3 w-3" aria-hidden="true" />
          Mock UI Preview
        </span>
        <label className="flex items-center gap-2">
          <span className="cr-label text-[9.5px] text-ink-invert/50">Scenario</span>
          <select
            value={scenarioId}
            onChange={(event) => setScenarioId(event.target.value)}
            className="h-7 cursor-pointer rounded-md border border-ink-invert/20 bg-ink px-2 text-[12px] text-ink-invert outline-none"
            aria-label="Preview scenario"
          >
            {PREVIEW_SCENARIOS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
        <span className="hidden min-w-0 flex-1 truncate text-[11.5px] text-ink-invert/50 md:inline">
          {scenario.purpose}
        </span>
        <button
          type="button"
          onClick={() => setAuditionOpen((open) => !open)}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-ink-invert/20 px-2 text-[11.5px] text-ink-invert/80 transition-colors hover:bg-ink-invert/10"
          aria-pressed={auditionOpen}
        >
          <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
          Sound assets
        </button>
        <span data-preview-log aria-live="polite" className="hidden max-w-64 truncate font-mono text-[11px] text-ink-invert/70 lg:inline" title={lastAction}>
          {lastAction}
        </span>
      </div>

      {auditionOpen ? <SoundAudition /> : null}

      <div className="min-h-0 flex-1">
        {view.screen === "join" ? (
          <div className="h-full overflow-y-auto">
            <JoinScreen
              view={view.join}
              onDisplayNameChange={(value) => {
                setJoinName(value);
                log(`onDisplayNameChange("${value}")`);
              }}
              onAdminPasswordChange={setJoinPassword}
              onUseSavedIdentityChange={setUseSavedIdentity}
              onSubmit={() => log("join onSubmit()")}
            />
          </div>
        ) : (
          <ChatScreen
            key={scenarioId}
            view={view.chat}
            callbacks={callbacks}
            timelineDom={bindings.timelineDom}
            composerDom={bindings.composerDom}
          />
        )}
      </div>
    </div>
  );
}

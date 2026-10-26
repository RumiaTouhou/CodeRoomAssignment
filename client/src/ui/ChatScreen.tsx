import { useEffect, useRef, useState } from "react";
import type { ChatScreenProps } from "../contract.js";
import { BookmarksPanel } from "./components/BookmarksPanel.jsx";
import { MemberActivity } from "./components/MemberActivity.jsx";
import { PinnedMessagePanel } from "./components/PinnedMessagePanel.jsx";
import { ChatComposer } from "./components/ChatComposer.jsx";
import { ConnectionBanner } from "./components/ConnectionBanner.jsx";
import { MessageList } from "./components/MessageList.jsx";
import { NoticeStack } from "./components/NoticeStack.jsx";
import { PreferencesPanel } from "./components/PreferencesPanel.jsx";
import { RoomHeader } from "./components/RoomHeader.jsx";
import { SearchPanel } from "./components/SearchPanel.jsx";
import { TypingIndicator } from "./components/TypingIndicator.jsx";
const COMPOSER_MIN_HEIGHT = 148;
const COMPOSER_DEFAULT_HEIGHT = 228;

function composerMaxHeight(): number {
  return Math.min(480, Math.max(300, Math.round(window.innerHeight * 0.6)));
}

function ComposerResizeHandle({ height, onChange }: { readonly height: number; readonly onChange: (height: number) => void }) {
  const start = useRef<{ y: number; height: number } | null>(null);
  const max = typeof window === "undefined" ? 480 : composerMaxHeight();
  const clamp = (value: number) => Math.min(max, Math.max(COMPOSER_MIN_HEIGHT, value));
  return (
    <div
      role="separator"
      aria-label="Resize message composer"
      aria-orientation="horizontal"
      aria-valuemin={COMPOSER_MIN_HEIGHT}
      aria-valuemax={max}
      aria-valuenow={Math.round(height)}
      tabIndex={0}
      className="cr-composer-resize"
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          onChange(clamp(height + (event.key === "ArrowUp" ? 16 : -16)));
        } else if (event.key === "Home") {
          event.preventDefault();
          onChange(COMPOSER_MIN_HEIGHT);
        } else if (event.key === "End") {
          event.preventDefault();
          onChange(max);
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        start.current = { y: event.clientY, height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        onChange(clamp(start.current.height - (event.clientY - start.current.y)));
      }}
      onPointerUp={(event) => {
        start.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { start.current = null; }}
    />
  );
}


/** Compose the chat view and callbacks with local preferences visibility. */
export function ChatScreen({ view, callbacks, timelineDom, composerDom }: ChatScreenProps) {
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  useEffect(() => {
    const handleResize = () => setComposerHeight((value) => Math.min(composerMaxHeight(), Math.max(COMPOSER_MIN_HEIGHT, value)));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper text-ink" data-reading-size={view.preferences.readingSize ?? "standard"}>
      <ConnectionBanner
        view={view.connection}
        onRetry={callbacks.onRetryConnection}
        onReturnToJoin={callbacks.onReturnToJoin}
      />

      <RoomHeader
        roomTitle={view.room.title}
        self={view.self}
        role={view.role ?? (view.pinned?.canManage ? "admin" : "guest")}
        memberCount={view.members.length}
        connection={view.connection}
        sound={view.sound}
        onOpenSearch={callbacks.onOpenSearch}
        onOpenBookmarks={callbacks.onOpenBookmarks}
        onSoundModeChange={callbacks.onSoundModeChange}
        onLeaveRoom={callbacks.onLeaveRoom}
        onOpenPreferences={() => setPreferencesOpen(true)}
      />

      <NoticeStack notices={view.notices} onDismiss={callbacks.onDismissNotice} />
      <PinnedMessagePanel
        message={view.pinned?.message ?? null}
        canManage={view.pinned?.canManage ?? false}
        pending={view.pinned?.pending ?? false}
        sourceAvailable={view.pinned?.sourceAvailable ?? true}
        readingSize={view.preferences.readingSize ?? "standard"}
        onCopy={callbacks.onCopyCode}
        onJump={(messageId) => callbacks.onJumpToMessage(messageId, "quote")}
        onSetPin={callbacks.onSetPin}
      />
      <MemberActivity items={view.activity ?? []} />

      {/* Content region: one scrolling message viewport + overlay panels */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList
          view={view.timeline}
          dom={timelineDom}
          callbacks={{
            onReply: callbacks.onReply,
            onSetReaction: callbacks.onSetReaction,
            onRetryMessage: callbacks.onRetryMessage,
            onRestoreToComposer: callbacks.onRestoreToComposer,
            onCopyCode: callbacks.onCopyCode,
            onSetPin: callbacks.onSetPin,
            onToggleExpanded: callbacks.onToggleExpanded,
            onToggleBookmark: callbacks.onToggleBookmark,
            onJumpToMessage: callbacks.onJumpToMessage,
            onJumpToLatest: callbacks.onJumpToLatest,
            onReturnToReadingPosition: callbacks.onReturnToReadingPosition,
          }}
        />
        {view.connection.phase !== "ended" && view.bookmarks?.open ? (
          <BookmarksPanel
            view={view.bookmarks}
            onClose={callbacks.onCloseBookmarks}
            onRemove={callbacks.onRemoveBookmark}
            onClear={callbacks.onClearBookmarks}
            onJump={callbacks.onJumpToBookmark}
            onCopy={callbacks.onCopyCode}
          />
        ) : null}
        {view.connection.phase !== "ended" ? <SearchPanel
          view={view.search}
          history={view.history}
          onQueryChange={callbacks.onSearchQueryChange}
          onSelectResult={(messageId) => callbacks.onJumpToMessage(messageId, "search")}
          onRetry={callbacks.onRetrySearch}
          onClose={callbacks.onCloseSearch}
        /> : null}
      </div>

      {/* Typing slot: fixed height, never pushes the composer */}
      <div className="mx-auto w-full max-w-[880px] px-3 sm:px-4">
        <TypingIndicator view={view.typing} />
      </div>

      <ComposerResizeHandle height={composerHeight} onChange={setComposerHeight} />
      <div className="shrink-0" style={{ height: `${composerHeight}px` }}>
        <ChatComposer
          view={view.composer}
          dom={composerDom}
          callbacks={{
          onDraftIntent: callbacks.onDraftIntent,
          onSubmit: callbacks.onSubmit,
          onComposerKey: callbacks.onComposerKey,
          onCompositionChange: callbacks.onCompositionChange,
          onComposerFocusChange: callbacks.onComposerFocusChange,
          onShortcutChange: callbacks.onShortcutChange,
          }}
        />
      </div>

      {preferencesOpen && view.connection.phase !== "ended" ? (
        <PreferencesPanel
          preferences={view.preferences}
          sound={view.sound}
          callbacks={{
            onSoundModeChange: callbacks.onSoundModeChange,
            onPreviewSound: callbacks.onPreviewSound,
            onShortcutChange: callbacks.onShortcutChange,
            onShareTypingChange: callbacks.onShareTypingChange,
            onReadingSizeChange: callbacks.onReadingSizeChange,
            onMemberSoundsChange: callbacks.onMemberSoundsChange,
          }}
          onClose={() => setPreferencesOpen(false)}
        />
      ) : null}
    </div>
  );
}

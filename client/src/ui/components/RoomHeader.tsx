import { Bookmark, LogOut, Search, Settings2, SquareTerminal, Volume2, VolumeX } from "lucide-react";
import type { ConnectionView, HeaderProps } from "../../contract.js";
import { Avatar } from "../Avatar.jsx";

interface RoomHeaderProps extends HeaderProps {
  /** Open the preferences dialog. */
  readonly onOpenPreferences?: () => void;
  readonly onOpenBookmarks: () => void;
  readonly role?: "guest" | "admin";
}

function connectionLabel(connection: ConnectionView): { text: string; dot: string } {
  switch (connection.phase) {
    case "ready":
      return { text: "Connected", dot: "bg-ok" };
    case "connecting":
      return { text: "Connecting…", dot: "bg-info" };
    case "synchronizing":
      return { text: "Syncing…", dot: "bg-info" };
    case "reconnecting":
      return { text: "Reconnecting…", dot: "bg-warn" };
    case "offline":
      return { text: "Offline", dot: "bg-danger" };
    case "ended":
      return { text: "Session ended", dot: "bg-danger" };
  }
}

const iconButton =
  "flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-sage hover:text-ink";

/** Room identity, connection state and room actions. */
export function RoomHeader({
  roomTitle,
  self,
  role = "guest",
  memberCount,
  connection,
  sound,
  onOpenSearch,
  onOpenBookmarks,
  onSoundModeChange,
  onLeaveRoom,
  onOpenPreferences,
}: RoomHeaderProps) {
  const status = connectionLabel(connection);
  const soundOn = sound.mode === "incoming";
  const soundBlocked = soundOn && sound.playback === "blocked";
  const soundUnavailable = soundOn && sound.playback === "unavailable";
  const soundUnverified = soundOn && sound.playback === "unverified";
  const soundTitle = soundUnavailable
    ? "Sound playback is unavailable in this browser."
    : soundBlocked
    ? "Your browser blocked sound playback."
    : soundUnverified
    ? "Incoming sound: On — playback has not been tested yet. Click to turn off"
    : soundOn
      ? "Incoming sound: On — click to turn off"
      : "Incoming sound: Off — click to turn on";

  return (
    <header className="z-10 border-b border-line bg-paper-raised">
      <div className="mx-auto grid min-h-14 w-full max-w-[880px] grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1 px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:px-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
          <SquareTerminal className="h-4.5 w-4.5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h1 className="min-w-0 max-w-full truncate text-[15px] font-semibold tracking-tight text-ink">
              {roomTitle}
            </h1>
            <span className="flex shrink-0 items-center gap-1.5" role="status" aria-label={`Connection: ${status.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
              <span className="cr-label text-ink-faint">{status.text}</span>
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[12.5px] text-ink-faint">
            <span className="flex min-w-0 items-center gap-1.5">
              <Avatar user={self} size="sm" />
              <span className="truncate font-medium text-ink-soft">{self.displayName}</span>
              <span className={`cr-label shrink-0 rounded px-1 py-px text-[9px] ${role === "admin" ? "bg-accent-soft text-accent-strong" : "bg-sage text-ink-soft"}`}>{role === "admin" ? "Admin" : "Guest"}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{memberCount} online</span>
          </div>
        </div>

        <nav className="col-span-2 flex items-center justify-end gap-1 border-t border-line pt-1 sm:col-span-1 sm:gap-0.5 sm:border-0 sm:pt-0" aria-label="Room actions">
          <button type="button" onClick={onOpenBookmarks} className={iconButton} title="Saved bookmarks" aria-label="Open bookmarks">
            <Bookmark className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          <button type="button" onClick={onOpenSearch} className={iconButton} title="Search recent messages" aria-label="Search recent messages">
            <Search className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onSoundModeChange(soundOn ? "off" : "incoming")}
            className={`${iconButton} ${soundUnavailable ? "text-danger" : soundBlocked ? "text-warn" : ""}`}
            title={soundTitle}
            aria-label={soundTitle}
            aria-pressed={soundOn}
          >
            {soundOn && !soundBlocked && !soundUnavailable ? (
              <Volume2 className="h-[18px] w-[18px]" aria-hidden="true" />
            ) : (
              <VolumeX className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>
          {onOpenPreferences ? (
            <button type="button" onClick={onOpenPreferences} className={iconButton} title="Preferences" aria-label="Open preferences">
              <Settings2 className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onLeaveRoom}
            className={`${iconButton} hover:bg-danger-soft hover:text-danger`}
            title="Leave room"
            aria-label="Leave room"
          >
            <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </nav>
      </div>
    </header>
  );
}

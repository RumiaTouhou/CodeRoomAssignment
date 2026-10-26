import { useRef } from "react";
import { createPortal } from "react-dom";
import { useLayerFocus } from "../useLayerFocus.js";
import type { ReactNode } from "react";
import { CloudOff, Loader2, LogIn, RefreshCw } from "lucide-react";
import type { ConnectionBannerProps, ConnectionView } from "../../contract.js";

const ENDED_COPY: Record<string, { title: string; body: string }> = {
  expired: {
    title: "Your session expired",
    body: "For security, sessions end after a period of time. Join again to continue.",
  },
  replaced: {
    title: "This session was opened in another window",
    body: "Only one window can use a session at a time. This window has been disconnected.",
  },
  revoked: {
    title: "This session was signed out",
    body: "The session is no longer valid. Join again to continue.",
  },
  "server-restarted": {
    title: "The server restarted",
    body: "The room history starts fresh after a restart. Join again to continue.",
  },
};

function EndedSession({ view, onReturnToJoin }: {
  readonly view: Extract<ConnectionView, { phase: "ended" }>;
  readonly onReturnToJoin: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayerFocus({ open: true, container: panelRef, initialFocus: buttonRef, modal: true });
  const copy = ENDED_COPY[view.reason] ?? ENDED_COPY.expired!;
  return createPortal(
    <div
      ref={panelRef}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-ended-title"
      aria-describedby="session-ended-description"
      className="fixed inset-0 z-40 flex items-center justify-center bg-paper/95 px-4 backdrop-blur-sm"
    >
      <div className="cr-fade-up w-full max-w-sm rounded-2xl border border-line bg-paper-raised p-6 text-center shadow-[0_8px_30px_oklch(0.32_0.015_140/0.12)]">
        <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-warn-soft text-warn">
          <CloudOff className="h-5 w-5" aria-hidden="true" />
        </span>
        <h2 id="session-ended-title" className="text-lg font-semibold text-ink">
          {copy.title}
        </h2>
        <p id="session-ended-description" className="mt-2 text-[14px] leading-relaxed text-ink-soft">{copy.body}</p>
        <button
          ref={buttonRef}
          type="button"
          onClick={onReturnToJoin}
          className="mt-5 flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent text-[14.5px] font-medium text-ink-invert transition-colors hover:bg-accent-strong"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Back to join screen
        </button>
      </div>
    </div>, document.body
  );
}

/** Render connection status; an ended session replaces the conversation. */
export function ConnectionBanner({ view, onRetry, onReturnToJoin }: ConnectionBannerProps) {
  if (view.phase === "ready") return null;

  if (view.phase === "ended") return <EndedSession view={view} onReturnToJoin={onReturnToJoin} />;

  const config: Record<string, { icon: ReactNode; text: string; tone: string; showRetry: boolean }> = {
    connecting: {
      icon: <Loader2 className="cr-spin h-3.5 w-3.5" aria-hidden="true" />,
      text: "Connecting…",
      tone: "bg-info-soft text-info",
      showRetry: false,
    },
    synchronizing: {
      icon: <Loader2 className="cr-spin h-3.5 w-3.5" aria-hidden="true" />,
      text: "Syncing messages…",
      tone: "bg-info-soft text-info",
      showRetry: false,
    },
    reconnecting: {
      icon: <Loader2 className="cr-spin h-3.5 w-3.5" aria-hidden="true" />,
      text: `Reconnecting… (attempt ${(view as Extract<ConnectionView, { phase: "reconnecting" }>).attempt})`,
      tone: "bg-warn-soft text-warn",
      showRetry: true,
    },
    offline: {
      icon: <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />,
      text: "Offline — messages can’t be sent right now.",
      tone: "bg-danger-soft text-danger",
      showRetry: (view as Extract<ConnectionView, { phase: "offline" }>).canRetry,
    },
  };
  const current = config[view.phase];
  if (!current) return null;

  return (
    <div role="status" className={`cr-fade-in z-20 flex items-center justify-center gap-3 px-4 py-1.5 ${current.tone}`}>
      <span className="flex items-center gap-2 text-[13px] font-medium">
        {current.icon}
        {current.text}
      </span>
      {current.showRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium underline underline-offset-2 transition-colors hover:opacity-80"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Retry now
        </button>
      ) : null}
    </div>
  );
}

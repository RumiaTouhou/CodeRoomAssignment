import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Eye, FileCode2, Loader2, Pin, PinOff, X } from "lucide-react";
import type { CopyResult, MessageView } from "../../contract.js";
import { useLayerFocus } from "../useLayerFocus.js";
import { CodeBlock } from "./CodeBlock.jsx";

interface PinnedMessagePanelProps {
  readonly message: MessageView | null;
  readonly canManage: boolean;
  readonly pending: boolean;
  readonly sourceAvailable?: boolean;
  readonly readingSize?: "standard" | "large" | "larger";
  readonly onJump: (messageId: string) => void;
  readonly onSetPin: (messageId: string | null) => void;
  readonly onCopy?: (source: string) => Promise<CopyResult>;
}

function PinnedMessageDetails({ message, sourceAvailable, readingSize, onJump, onCopy, onClose }: {
  readonly message: MessageView;
  readonly sourceAvailable: boolean;
  readonly readingSize: "standard" | "large" | "larger";
  readonly onJump: () => void;
  readonly onCopy: (source: string) => Promise<CopyResult>;
  readonly onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useLayerFocus({ open: true, container: panelRef, initialFocus: closeRef, modal: true, onClose });
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/25 p-3 backdrop-blur-[2px] sm:items-center">
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Pinned message details" data-reading-size={readingSize} className="cr-pop flex max-h-[calc(100dvh-24px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <Pin className="h-4 w-4 text-accent-strong" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-ink">Pinned message</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close pinned message" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sage hover:text-ink"><X className="h-4 w-4" aria-hidden="true" /></button>
        </div>
        <div className="cr-scroll min-h-0 overflow-y-auto p-4">
          <p className="mb-2 text-[13px] font-semibold text-ink-soft">{message.author.displayName}</p>
          {message.content.kind === "code" ? <CodeBlock source={message.content.source} language={message.content.language} matches={[]} onCopy={() => onCopy(message.content.kind === "code" ? message.content.source : "")} /> : <p className="cr-message-text whitespace-pre-wrap break-words leading-relaxed text-ink [tab-size:2]">{message.content.text}</p>}
        </div>
        <div className="shrink-0 border-t border-line px-4 py-3">
          {!sourceAvailable ? <p className="mb-2 text-[12px] text-ink-faint">Original message is outside retained history. The pinned snapshot remains available.</p> : null}
          <button type="button" disabled={!sourceAvailable} onClick={onJump} className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-accent-soft px-3 text-[13px] font-medium text-accent-strong transition-colors hover:bg-sage disabled:cursor-not-allowed disabled:opacity-45"><ArrowUpRight className="h-4 w-4" aria-hidden="true" />Jump to pinned message</button>
        </div>
      </div>
    </div>, document.body,
  );
}

export function PinnedMessagePanel({ message, canManage, pending, sourceAvailable = true, readingSize = "standard", onJump, onSetPin, onCopy }: PinnedMessagePanelProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => setDetailsOpen(false), [message?.key]);
  if (!message) return null;
  const messageId = message.identity.kind === "canonical" ? message.identity.messageId : null;
  const raw = message.content.kind === "text" ? message.content.text : message.content.source;

  return (
    <>
    <section aria-label="Pinned message" className="shrink-0 border-b border-accent/20 bg-accent-softer">
      <div className="mx-auto flex w-full max-w-[880px] items-start gap-2.5 px-3 py-2 sm:px-4">
        <Pin className="mt-1 h-4 w-4 shrink-0 text-accent-strong" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="cr-label text-[10px] text-accent-strong">Pinned for everyone</h2>
            <span className="truncate text-[12px] font-medium text-ink-soft">{message.author.displayName}</span>
            {message.content.kind === "code" ? (
              <span className="flex items-center gap-1 text-[11px] text-ink-faint"><FileCode2 className="h-3 w-3" aria-hidden="true" />{message.content.language}</span>
            ) : null}
          </div>
          <p className={`mt-0.5 line-clamp-2 break-words text-[13px] leading-snug text-ink ${message.content.kind === "code" ? "font-mono" : ""}`}>{raw}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={() => setDetailsOpen(true)} aria-label="View pinned message" title="View pinned message" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-accent-strong transition-colors hover:bg-sage">
            <Eye className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => { if (messageId) onJump(messageId); }} disabled={!sourceAvailable || messageId === null} aria-label="Jump to pinned message" title={sourceAvailable ? "Jump to pinned message" : "Original message is outside retained history"} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-accent-strong transition-colors hover:bg-sage disabled:cursor-not-allowed disabled:opacity-40">
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </button>
          {canManage ? (
            <button type="button" onClick={() => onSetPin(null)} disabled={pending} aria-label="Unpin message" title="Unpin message" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sage hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">
              {pending ? <Loader2 className="cr-spin h-4 w-4" aria-hidden="true" /> : <PinOff className="h-4 w-4" aria-hidden="true" />}
            </button>
          ) : null}
        </div>
      </div>
    </section>
    {detailsOpen ? <PinnedMessageDetails message={message} sourceAvailable={sourceAvailable && messageId !== null} readingSize={readingSize} onClose={() => setDetailsOpen(false)} onCopy={onCopy ?? (async () => ({ ok: false, reason: "unavailable" }))} onJump={() => { setDetailsOpen(false); if (messageId) onJump(messageId); }} /> : null}
    </>
  );
}

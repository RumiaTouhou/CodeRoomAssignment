import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Bookmark, Check, ChevronDown, ChevronUp, Copy, FileCode2, Trash2, X } from "lucide-react";
import type { BookmarkView, CopyResult } from "../../contract.js";
import { formatDateTime, formatMessageTime } from "../format.js";
import { useLayerFocus } from "../useLayerFocus.js";

interface BookmarksPanelProps {
  readonly view: { readonly open: boolean; readonly items: readonly BookmarkView[] };
  readonly onClose: () => void;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
  readonly onJump: (id: string) => void;
  readonly onCopy: (source: string) => Promise<CopyResult>;
}

interface BookmarkCardProps {
  readonly item: BookmarkView;
  readonly onRemove: BookmarksPanelProps["onRemove"];
  readonly onJump: BookmarksPanelProps["onJump"];
  readonly onCopy: BookmarksPanelProps["onCopy"];
}

const actionClass = "flex min-h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors hover:bg-sage hover:text-ink disabled:cursor-not-allowed disabled:opacity-45";

function BookmarkCard({ item, onRemove, onJump, onCopy }: BookmarkCardProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const raw = item.content.kind === "text" ? item.content.text : item.content.source;
  const excerpt = Array.from(raw).slice(0, 720).join("");
  const truncated = excerpt.length < raw.length;
  const preview = truncated && !expanded ? `${excerpt}…` : raw;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetRef.current !== null) clearTimeout(resetRef.current);
    };
  }, []);

  const handleCopy = async () => {
    let result: CopyResult;
    try {
      result = await onCopy(raw);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (!mountedRef.current) return;
    setCopyState(result.ok ? "copied" : "failed");
    if (resetRef.current !== null) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setCopyState("idle"), 2000);
  };

  return (
    <li className="min-w-0 overflow-hidden rounded-xl border border-line bg-paper">
      <div className="flex min-w-0 items-baseline gap-2 px-3 pt-3">
        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{item.author.displayName}</span>
        <time dateTime={new Date(item.createdAt).toISOString()} title={formatDateTime(item.createdAt)} className="cr-label shrink-0 text-[9.5px] text-ink-faint">
          {formatMessageTime(item.createdAt)}
        </time>
        {item.content.kind === "code" ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
            <FileCode2 className="h-3 w-3" aria-hidden="true" />
            {item.content.language}
          </span>
        ) : null}
      </div>

      {item.content.kind === "code" ? (
        <pre id={contentId} className="cr-code cr-scroll mx-3 mb-2 mt-2 max-h-36 overflow-auto rounded-lg bg-paper-sunken p-2 text-[12px] text-ink-soft">
          <code>{preview}</code>
        </pre>
      ) : (
        <p id={contentId} className="cr-message-text cr-scroll mx-3 mb-2 mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-soft">{preview}</p>
      )}
      {truncated ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mx-1.5 mb-1 flex min-h-8 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-accent-strong transition-colors hover:bg-sage"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          {expanded ? "Collapse bookmark" : "Show full bookmark"}
        </button>
      ) : null}

      {!item.sourceAvailable ? (
        <p className="px-3 pb-2 text-[11.5px] text-ink-faint">Original message is no longer available. The saved snapshot remains.</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-0.5 border-t border-line px-1.5 py-1">
        <button
          type="button"
          onClick={() => onJump(item.id)}
          disabled={!item.sourceAvailable}
          className={actionClass}
          aria-label={`View source from ${item.author.displayName}`}
          title={item.sourceAvailable ? "View original message" : "Original message is outside retained history"}
        >
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          View source
        </button>
        <button type="button" onClick={() => void handleCopy()} className={actionClass} aria-label={`Copy bookmark from ${item.author.displayName}`}>
          {copyState === "copied" ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          <span aria-live="polite" className={copyState === "failed" ? "text-danger" : copyState === "copied" ? "text-ok" : ""}>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </span>
        </button>
        <button type="button" onClick={() => onRemove(item.id)} className={`${actionClass} ml-auto hover:bg-danger-soft hover:text-danger`} aria-label={`Remove bookmark from ${item.author.displayName}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Remove
        </button>
      </div>
    </li>
  );
}

export function BookmarksPanel({ view, onClose, onRemove, onClear, onJump, onCopy }: BookmarksPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  useLayerFocus({ open: view.open, container: panelRef, initialFocus: closeRef, onClose });

  useEffect(() => {
    if (!view.open || view.items.length === 0) setConfirmClear(false);
  }, [view.open, view.items.length]);

  if (!view.open) return null;

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label="Saved bookmarks"
      className="cr-fade-in absolute inset-y-0 right-0 z-30 flex w-full max-w-[380px] flex-col border-l border-line bg-paper-raised shadow-[-8px_0_30px_oklch(0.32_0.015_140/0.10)]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Bookmark className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="cr-label min-w-0 flex-1 text-ink-soft">Saved bookmarks</h2>
        <button ref={closeRef} type="button" onClick={onClose} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sage hover:text-ink" aria-label="Close bookmarks">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="shrink-0 border-b border-line px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] text-ink-faint">Saved locally · {view.items.length} {view.items.length === 1 ? "snapshot" : "snapshots"}</p>
          {view.items.length > 0 && !confirmClear ? (
            <button type="button" onClick={() => setConfirmClear(true)} className="min-h-8 cursor-pointer rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger">Clear all</button>
          ) : null}
        </div>
        {confirmClear ? (
          <div className="mt-2 rounded-lg border border-line bg-paper p-2.5" role="group" aria-label="Confirm clearing bookmarks">
            <p className="text-[12.5px] text-ink-soft">Remove all saved bookmarks?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => { closeRef.current?.focus({ preventScroll: true }); onClear(); setConfirmClear(false); }} className="min-h-8 cursor-pointer rounded-md bg-danger-soft px-2.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/15">Clear bookmarks</button>
              <button type="button" onClick={() => { closeRef.current?.focus({ preventScroll: true }); setConfirmClear(false); }} className={actionClass}>Cancel</button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="cr-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {view.items.length === 0 ? (
          <div className="flex flex-col items-center px-5 pt-10 text-center">
            <Bookmark className="mb-3 h-7 w-7 text-ink-faint" aria-hidden="true" />
            <p className="text-[14px] font-medium text-ink-soft">No saved bookmarks</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-faint">Use the bookmark action on a message to keep a local snapshot.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {view.items.map((item) => <BookmarkCard key={item.id} item={item} onRemove={(id) => { closeRef.current?.focus({ preventScroll: true }); onRemove(id); }} onJump={onJump} onCopy={onCopy} />)}
          </ul>
        )}
      </div>
    </aside>
  );
}

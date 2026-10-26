import { useRef } from "react";
import { FileCode2, Loader2, RotateCcw, SearchX, X } from "lucide-react";
import type { SearchPanelProps } from "../../contract.js";
import { formatDateTime, formatMessageTime } from "../format.js";
import { HighlightText } from "../HighlightText.jsx";
import { useLayerFocus } from "../useLayerFocus.js";

/** Render retained-history search results, loading state and retention scope. */
export function SearchPanel({ view, history, onQueryChange, onSelectResult, onRetry, onClose }: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const panelRef = useRef<HTMLElement>(null);
  useLayerFocus({ open: view.phase !== "closed", container: panelRef, initialFocus: inputRef, onClose });

  if (view.phase === "closed") return null;

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label="Search recent messages"
      className="cr-fade-in absolute inset-y-0 right-0 z-30 flex w-full max-w-[360px] flex-col border-l border-line bg-paper-raised shadow-[-8px_0_30px_oklch(0.32_0.015_140/0.10)]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="cr-label flex-1 text-ink-soft">Search recent messages</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sage hover:text-ink"
          aria-label="Close search"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="shrink-0 border-b border-line p-3">
        <input
          ref={inputRef}
          type="search"
          value={view.query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search recent messages"
          aria-label="Search query"
          className="h-10 w-full rounded-lg border border-line-strong bg-paper px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
        />
        <p className="mt-2 text-[12px] leading-snug text-ink-faint">
          Search is limited to retained messages — the last {history.retainedCount} of at most{" "}
          {history.limit}.
        </p>
      </div>

      <div className="cr-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {view.phase === "idle" ? (
          <p className="px-1 pt-2 text-[13.5px] text-ink-faint">
            Type to search the retained history.
          </p>
        ) : null}

        {view.phase === "loading" ? (
          <p role="status" className="flex items-center gap-2 px-1 pt-2 text-[13.5px] text-ink-faint">
            <Loader2 className="cr-spin h-4 w-4" aria-hidden="true" />
            Searching…
          </p>
        ) : null}

        {view.phase === "error" ? (
          <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3">
            <p className="text-[13.5px] font-medium text-ink">{view.message}</p>
            {view.retryable ? (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-paper-raised px-3 text-[13px] font-medium text-ink transition-colors hover:bg-sage"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Retry search
              </button>
            ) : null}
          </div>
        ) : null}

        {view.phase === "empty" ? (
          <div className="flex flex-col items-center px-4 pt-10 text-center">
            <SearchX className="mb-2 h-6 w-6 text-ink-faint" aria-hidden="true" />
            <p className="text-[13.5px] text-ink-soft">No matches in retained history.</p>
          </div>
        ) : null}

        {view.phase === "results" ? (
          <div>
            {view.mayBeStale ? (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-warn-soft px-3 py-2">
                <span className="text-[12.5px] text-ink">Results may be out of date</span>
                <button
                  type="button"
                  onClick={onRetry}
                  className="h-7 shrink-0 cursor-pointer rounded-md px-2 text-[12.5px] font-medium text-ink underline underline-offset-2 transition-colors hover:bg-sage"
                >
                  Search again
                </button>
              </div>
            ) : null}
            <p className="cr-label mb-2 px-1 text-ink-faint">
              {view.response.totalMatches} {view.response.totalMatches === 1 ? "match" : "matches"}
              {view.response.truncated ? ` · showing first ${view.response.results.length}` : ""}
            </p>
            <ul className="flex flex-col gap-1.5">
              {view.response.results.map((hit) => (
                <li key={hit.messageId}>
                  <button
                    type="button"
                    onClick={() => onSelectResult(hit.messageId)}
                    className="w-full cursor-pointer rounded-xl border border-line bg-paper p-3 text-left transition-colors hover:bg-sage"
                    aria-label={`Jump to message from ${hit.author.displayName}`}
                  >
                    <span className="mb-1 flex items-baseline gap-2">
                      <span className="text-[13px] font-semibold text-ink">{hit.author.displayName}</span>
                      <time className="cr-label text-[9.5px] text-ink-faint" dateTime={new Date(hit.createdAt).toISOString()} title={formatDateTime(hit.createdAt)}>
                        {formatMessageTime(hit.createdAt)}
                      </time>
                      {hit.kind === "code" ? (
                        <FileCode2 className="h-3.5 w-3.5 text-ink-faint" aria-label="Code message" />
                      ) : null}
                    </span>
                    <span className="block break-words text-[13px] leading-snug text-ink-soft">
                      <HighlightText text={hit.snippet} matches={hit.matches} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

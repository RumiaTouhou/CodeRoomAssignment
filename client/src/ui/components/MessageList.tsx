import { CornerUpLeft, MessageSquareDashed } from "lucide-react";
import type { MessageListProps } from "../../contract.js";
import { MessageRow } from "./MessageRow.jsx";
import { UnreadButton } from "./UnreadButton.jsx";

/** Attach application scroll and row bindings to the conversation viewport. */
export function MessageList({ view, dom, callbacks }: MessageListProps) {
  const hasMessages = view.items.some((item) => item.type === "message");

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={dom.viewportRef}
        onScroll={dom.onScroll}
        role="log"
        aria-label="Conversation"
        className="cr-scroll h-full overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-[880px] px-3 pb-24 pt-3 sm:px-4">
          {hasMessages ? (
            <ol className="flex flex-col">
              {view.items.map((item) => {
                if (item.type === "date-separator") {
                  return (
                    <li key={item.key} ref={dom.rowRef(item.key)} className="my-4 flex items-center gap-3" aria-hidden="true">
                      <span className="h-px flex-1 bg-line" />
                      <span className="cr-label text-ink-faint">{item.label}</span>
                      <span className="h-px flex-1 bg-line" />
                    </li>
                  );
                }
                if (item.type === "history-boundary") {
                  return (
                    <li key={item.key} ref={dom.rowRef(item.key)} className="my-4 flex justify-center">
                      <span className="rounded-full border border-dashed border-line-strong px-3 py-1 text-center text-[12px] text-ink-faint">
                        {item.label}
                      </span>
                    </li>
                  );
                }
                return (
                  <MessageRow
                    key={item.key}
                    view={item.message}
                    registerNode={dom.rowRef(item.key)}
                    callbacks={callbacks}
                  />
                );
              })}
            </ol>
          ) : (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center">
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent-strong">
                <MessageSquareDashed className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="text-[15px] font-medium text-ink">No messages yet.</p>
              <p className="mt-1 text-[13.5px] text-ink-faint">Start the conversation.</p>
            </div>
          )}
        </div>
      </div>

      {/* Floating navigation affordances — anchored to the viewport, never scrolling it */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center gap-2 px-3">
        {view.canReturnToReadingPosition ? (
          <button
            type="button"
            onClick={callbacks.onReturnToReadingPosition}
            className="cr-pop pointer-events-auto flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-paper-raised px-3.5 text-[13px] font-medium text-ink shadow-[0_4px_16px_oklch(0.32_0.015_140/0.14)] transition-colors hover:bg-sage"
          >
            <CornerUpLeft className="h-4 w-4 text-accent" aria-hidden="true" />
            Back to reading position
          </button>
        ) : null}
        <UnreadButton
          count={view.unseenIncomingCount}
          visible={!view.atBottom && view.unseenIncomingCount > 0}
          onActivate={callbacks.onJumpToLatest}
        />
      </div>
    </div>
  );
}

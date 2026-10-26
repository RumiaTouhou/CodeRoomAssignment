import { useId } from "react";
import { Bookmark, ChevronDown, ChevronUp, LogIn, LogOut, Pin, Reply, RotateCcw } from "lucide-react";
import type { MessageId, MessageRowProps } from "../../contract.js";
import { Avatar } from "../Avatar.jsx";
import { formatDateTime, formatMessageTime } from "../format.js";
import { HighlightText } from "../HighlightText.jsx";
import { CodeBlock } from "./CodeBlock.jsx";
import { DeliveryStatus } from "./DeliveryStatus.jsx";
import { QuotePreview } from "./QuotePreview.jsx";
import { ReactionBar } from "./ReactionBar.jsx";

/** Continuation rows share the author header while retaining per-message actions. */
export function MessageRow({ view, registerNode, callbacks }: MessageRowProps) {
  const messageId: MessageId | null =
    view.identity.kind === "canonical" ? view.identity.messageId : null;
  const operationId = view.identity.kind === "outbox" ? view.identity.operationId : null;
  const start = view.grouping === "start";
  const contentId = useId();
  const fold = view.fold ?? { collapsible: false, expanded: true };
  const collapsed = fold.collapsible && !fold.expanded;
  const content = view.content;
  const timeLabel = formatMessageTime(view.createdAt);
  const exactTime = formatDateTime(view.createdAt);

  if (view.systemEvent) {
    const Icon = view.systemEvent === "left" ? LogOut : view.systemEvent === "returned" ? RotateCcw : LogIn;
    const text = content.kind === "text" ? content.text : "";
    return (
      <li ref={registerNode} className="my-1.5 flex justify-center" role="status">
        <div className="flex max-w-full items-center gap-2 px-2 py-1.5 text-[12.5px] text-ink-faint">
          <Icon className="h-3.5 w-3.5 shrink-0 text-accent-strong" aria-hidden="true" />
          <span className="truncate">{text}</span>
          <time className="cr-label shrink-0 text-[9px] text-ink-faint" dateTime={new Date(view.createdAt).toISOString()} title={exactTime}>
            {timeLabel}
          </time>
        </div>
      </li>
    );
  }

  const jumpToQuote =
    view.quote && view.quote.availability === "available"
      ? () => callbacks.onJumpToMessage(view.quote!.messageId, "quote")
      : () => {};

  return (
    <li
      ref={registerNode}
      className={`group relative rounded-xl px-2 py-1 transition-colors hover:bg-sage/15 focus-within:bg-sage/15 ${start ? "mt-3 first:mt-0" : "mt-0.5"} ${
        view.highlighted ? "cr-highlight-ring" : ""
      }`}
    >
      <div className="flex gap-2.5">
        {/* Avatar column: fixed width keeps continuation rows aligned */}
        <div className="flex w-8 shrink-0 justify-center">
          {start ? <Avatar user={view.author} /> : (
            <span
              className="cr-label mt-1 text-[9px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              aria-hidden="true"
            >
              {timeLabel}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {start ? (
            <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13.5px] font-semibold text-ink">
                {view.author.displayName}
              </span>
              {view.isMine ? (
                <span className="cr-label rounded bg-accent-soft px-1 py-px text-[9px] text-accent-strong">You</span>
              ) : null}
              <time className="cr-label text-[9.5px] text-ink-faint" dateTime={new Date(view.createdAt).toISOString()} title={exactTime}>
                {timeLabel}
              </time>
            </div>
          ) : null}

          {view.quote ? <QuotePreview view={view.quote} onNavigate={jumpToQuote} /> : null}

          <div className="flex max-w-full items-end gap-1.5">
            <div
              className={`w-fit max-w-full rounded-xl px-3 py-2 ${
                view.isMine
                  ? "border border-accent/25 bg-accent-softer"
                  : "border border-line bg-paper-raised"
              }`}
            >
            <div id={contentId}>
            {content.kind === "text" ? (
              <p className={`cr-message-text whitespace-pre-wrap break-words leading-relaxed text-ink [tab-size:2] ${collapsed ? "cr-folded-text" : ""}`}>
                <HighlightText text={content.text} matches={view.searchMatches} />
              </p>
            ) : (
              <div className="w-[560px] max-w-full">
                <CodeBlock
                  source={content.source}
                  language={content.language}
                  matches={view.searchMatches}
                  onCopy={() => callbacks.onCopyCode(content.source)}
                  collapsed={collapsed}
                />
              </div>
            )}
            </div>
              {fold.collapsible ? (
                <button
                type="button"
                onClick={() => callbacks.onToggleExpanded(view.key)}
                aria-expanded={fold.expanded}
                aria-controls={contentId}
                className="mt-2 flex min-h-8 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12.5px] font-medium text-accent-strong transition-colors hover:bg-sage"
              >
                {fold.expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                {fold.expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
            {view.delivery.phase === "confirmed" ? (
              <DeliveryStatus
                delivery={view.delivery}
                operationId={operationId}
                canRestoreToComposer={false}
                onRetryMessage={callbacks.onRetryMessage}
                onRestoreToComposer={callbacks.onRestoreToComposer}
              />
            ) : null}
          </div>

          {view.actions.canReact || view.reactions.some((r) => r.count > 0) ? (
            <ReactionBar
              reactions={view.reactions}
              enabled={view.actions.canReact && messageId !== null}
              onSet={(emoji, active) => {
                if (messageId !== null) callbacks.onSetReaction(messageId, emoji, active);
              }}
            />
          ) : null}

          {(view.isMine || view.delivery.phase !== "incoming") && view.delivery.phase !== "confirmed" ? (
            <div className="mt-1">
              <DeliveryStatus
                delivery={view.delivery}
                operationId={operationId}
                canRestoreToComposer={view.actions.canRestoreToComposer}
                onRetryMessage={callbacks.onRetryMessage}
                onRestoreToComposer={callbacks.onRestoreToComposer}
              />
            </div>
          ) : null}
          {messageId !== null ? <div className="cr-message-actions flex items-center gap-0.5 rounded-lg border border-line bg-paper-raised p-0.5 shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {messageId !== null && view.actions.canReply ? (
            <button
              type="button"
              onClick={() => callbacks.onReply(messageId)}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sage hover:text-ink"
              title={`Reply to ${view.author.displayName}`}
              aria-label={`Reply to ${view.author.displayName}`}
            >
              <Reply className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
          {messageId !== null ? (
            <button
              type="button"
              onClick={() => callbacks.onToggleBookmark(messageId)}
              aria-pressed={view.bookmarked}
              aria-label={`Bookmark message from ${view.author.displayName}`}
              title={view.bookmarked ? "Remove bookmark" : "Save bookmark"}
              className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-sage hover:text-ink ${view.bookmarked ? "text-accent-strong" : "text-ink-faint"}`}
            >
              <Bookmark className="h-4 w-4" fill={view.bookmarked ? "currentColor" : "none"} aria-hidden="true" />
            </button>
          ) : null}
          {messageId !== null && view.actions.canPin ? (
            <button
              type="button"
              onClick={() => callbacks.onSetPin(messageId)}
              aria-label={`Pin message from ${view.author.displayName}`}
              title="Pin for everyone"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sage hover:text-ink"
            >
              <Pin className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
          </div> : null}
        </div>
      </div>
    </li>
  );
}

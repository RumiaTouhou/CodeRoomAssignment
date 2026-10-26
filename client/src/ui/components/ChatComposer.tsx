import { useId, useLayoutEffect, useRef } from "react";
import { Code2, HardDriveDownload, SendHorizonal, Type, X } from "lucide-react";
import type { ComposerProps, ComposerView } from "../../contract.js";
import { CODE_LANGUAGES } from "../../contract.js";
import { formatBytes } from "../format.js";

const DISABLED_TITLES: Record<NonNullable<ComposerView["disabledReason"]>, string> = {
  empty: "Write a message first",
  offline: "You’re offline — messages can’t be sent right now",
  synchronizing: "Hold on — still syncing messages",
  "too-large": "Message is too large to send",
  "outbox-full": "Too many unconfirmed messages — wait for confirmations",
  "session-ended": "This session has ended",
};

/** Forward input, composition and keyboard facts to the application.
 * A consumed keyboard event cannot submit a second time. */
export function ChatComposer({ view, dom, callbacks }: ComposerProps) {
  const { draft } = view;
  const codeMode = draft.mode === "code";
  const value = codeMode ? draft.codeBuffer.source : draft.textBuffer;
  const keyboardHintId = useId();
  const releaseTabFocus = useRef(false);
  const pendingCaret = useRef<{
    node: HTMLTextAreaElement;
    value: string;
    mode: typeof draft.mode;
    position: number;
    scrollTop: number;
    scrollLeft: number;
  } | null>(null);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    if (!caret || caret.mode !== draft.mode || caret.value !== value
      || !caret.node.isConnected || document.activeElement !== caret.node) return;
    caret.node.setSelectionRange(caret.position, caret.position);
    caret.node.scrollTop = caret.scrollTop;
    caret.node.scrollLeft = caret.scrollLeft;
  });

  const nearLimit = view.bodyUtf8Bytes > view.bodyLimitUtf8Bytes * 0.75;
  const overLimit = view.bodyUtf8Bytes > view.bodyLimitUtf8Bytes;

  const shortcutHint = codeMode
    ? "Ctrl/⌘+Enter to send"
    : view.shortcut === "enter"
      ? "Enter to send · Shift+Enter for a new line"
      : "Ctrl/⌘+Enter to send · Enter for a new line";

  return (
    <div className="h-full overflow-hidden border-t border-line bg-paper-raised">
      <div className="mx-auto flex h-full w-full max-w-[880px] flex-col px-3 pb-3 pt-1 sm:px-4">
        {/* Reply target strip */}
        {view.replyPreview ? (
          <div className="cr-fade-in mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5">
            <span className="cr-label max-w-full break-words text-accent-strong">
              Replying to {view.replyPreview.author.displayName}
            </span>
            <div className="min-w-[100px] flex-1">
              <p className="truncate text-[14px] text-ink-soft">{view.replyPreview.previewText}</p>
              {view.replyPreview.availability === "expired" ? <p className="text-[12px] text-ink-faint">Original message is no longer retained.</p> : null}
            </div>
            <button
              type="button"
              onClick={() => callbacks.onDraftIntent({ type: "reply.cleared" })}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-sage hover:text-ink"
              aria-label="Cancel reply"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-line-strong bg-paper transition-colors focus-within:border-accent">
          {/* Toolbar: mode switch + language picker */}
          <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1">
            <div role="group" aria-label="Composer mode" className="flex rounded-lg bg-sage/60 p-0.5">
              <button
                type="button"
                aria-pressed={!codeMode}
                onClick={() => callbacks.onDraftIntent({ type: "mode.changed", value: "text" })}
                className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors ${
                  !codeMode ? "bg-paper-raised text-ink shadow-[0_1px_2px_oklch(0.32_0.015_140/0.08)]" : "text-ink-faint hover:text-ink"
                }`}
              >
                <Type className="h-3.5 w-3.5" aria-hidden="true" />
                Text
              </button>
              <button
                type="button"
                aria-pressed={codeMode}
                onClick={() => callbacks.onDraftIntent({ type: "mode.changed", value: "code" })}
                className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors ${
                  codeMode ? "bg-paper-raised text-ink shadow-[0_1px_2px_oklch(0.32_0.015_140/0.08)]" : "text-ink-faint hover:text-ink"
                }`}
              >
                <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
                Code
              </button>
            </div>

            {codeMode ? (
              <label className="flex items-center gap-1.5">
                <span className="cr-label text-ink-faint">Language</span>
                <select
                  value={draft.codeBuffer.language}
                  onChange={(event) =>
                    callbacks.onDraftIntent({
                      type: "language.changed",
                      value: event.target.value as (typeof CODE_LANGUAGES)[number],
                    })
                  }
                  className="h-7 cursor-pointer rounded-md border border-line bg-paper-raised px-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                >
                  {CODE_LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {language}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <span className="ml-auto flex items-center gap-2">
              {nearLimit ? (
                <span
                  className={`cr-label ${overLimit ? "text-danger" : "text-ink-faint"}`}
                  aria-live="polite"
                >
                  {formatBytes(view.bodyUtf8Bytes)} / {formatBytes(view.bodyLimitUtf8Bytes)}
                </span>
              ) : null}
            </span>
          </div>

          <textarea
            ref={dom.textareaRef}
            value={value}
            rows={codeMode ? 6 : 2}
            placeholder={codeMode ? "Paste or write code…" : "Write a message…"}
            aria-label={codeMode ? "Code message" : "Message"}
            aria-describedby={keyboardHintId}
            onChange={(event) =>
              callbacks.onDraftIntent(
                codeMode
                  ? { type: "code.changed", value: event.target.value }
                  : { type: "text.changed", value: event.target.value },
              )
            }
            onKeyDown={(event) => {
              const native = event.nativeEvent as KeyboardEvent;
              const composing = view.isComposing || native.isComposing || native.keyCode === 229;
              const unmodified = !event.ctrlKey && !event.metaKey && !event.altKey;
              if (!composing && unmodified && event.key === "Escape") {
                releaseTabFocus.current = true;
                return;
              }
              const moveFocus = releaseTabFocus.current;
              releaseTabFocus.current = false;
              if (!composing && unmodified && !event.shiftKey && event.key === "Tab") {
                if (moveFocus) return;
                event.preventDefault();
                const node = event.currentTarget;
                const position = node.selectionStart + 1;
                const text = node.value.slice(0, node.selectionStart) + "\t" + node.value.slice(node.selectionEnd);
                pendingCaret.current = { node, value: text, mode: draft.mode, position, scrollTop: node.scrollTop, scrollLeft: node.scrollLeft };
                callbacks.onDraftIntent({ type: codeMode ? "code.changed" : "text.changed", value: text });
                return;
              }
              const consumed = callbacks.onComposerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                isComposing: event.nativeEvent.isComposing,
                legacyKeyCode: typeof native.keyCode === "number" ? native.keyCode : 0,
              });
              if (consumed) event.preventDefault();
            }}
            onCompositionStart={() => callbacks.onCompositionChange(true)}
            onCompositionEnd={() => callbacks.onCompositionChange(false)}
            onFocus={() => callbacks.onComposerFocusChange(true)}
            onBlur={() => { releaseTabFocus.current = false; callbacks.onComposerFocusChange(false); }}
            className={`cr-scroll min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2.5 text-[16px] text-ink outline-none placeholder:text-ink-faint [tab-size:2] ${
              codeMode ? "cr-code" : "cr-composer-text"
            }`}
          />

          <div className="flex items-center gap-2 px-2 pb-2">
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() =>
                  callbacks.onShortcutChange(view.shortcut === "enter" ? "mod-enter" : "enter")
                }
                className="hidden max-w-full cursor-pointer truncate rounded-md px-1 py-0.5 text-left text-[12px] text-ink-faint transition-colors hover:bg-sage hover:text-ink-soft sm:block"
                title="Change send shortcut"
              >
                {shortcutHint}
              </button>
              <p id={keyboardHintId} className="px-1 text-[12px] leading-snug text-ink-faint">
                Tab inserts a tab. Esc then Tab moves focus.
                <span className="sr-only"> Shift+Tab moves to the previous control.</span>
              </p>
            </div>

            {view.draftStorage === "unavailable" ? (
              <span className="flex items-center gap-1 text-[12px] text-warn">
                <HardDriveDownload className="h-3.5 w-3.5" aria-hidden="true" />
                Drafts can’t be saved in this browser.
              </span>
            ) : null}

            <button
              type="button"
              disabled={!view.canSubmit}
              title={view.disabledReason ? DISABLED_TITLES[view.disabledReason] : "Send message"}
              onClick={() =>
                callbacks.onSubmit({ draftRevision: draft.revision, trigger: "button" })
              }
              className="ml-auto flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-accent px-4 text-[14px] font-medium text-ink-invert transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-45"
            >
              <SendHorizonal className="h-4 w-4" aria-hidden="true" />
              Send
            </button>
          </div>
        </div>

        {view.error ? (
          <p role="alert" className="mt-1.5 text-[12.5px] text-danger">
            {view.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

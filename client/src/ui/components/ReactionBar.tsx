import { useEffect, useRef, useState } from "react";
import { Loader2, SmilePlus } from "lucide-react";
import type { ReactionBarProps, ReactionEmoji } from "../../contract.js";
import { REACTION_EMOJIS } from "../../contract.js";
import { focusableElements, useLayerFocus } from "../useLayerFocus.js";

const EMOJI_NAMES: Record<ReactionEmoji, string> = {
  "👍": "thumbs up", "❤️": "heart", "😂": "joy", "🎉": "party", "✅": "check mark",
};

export function ReactionBar({ reactions, enabled, onSet }: ReactionBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = pickerOpen && enabled;
  const blocked = (emoji: ReactionEmoji) => {
    const reaction = reactions.find((item) => item.emoji === emoji);
    return !enabled || reaction?.pending === true || reaction?.enabled === false;
  };
  const set = (emoji: ReactionEmoji) => {
    if (!blocked(emoji)) onSet(emoji, !(reactions.find((item) => item.emoji === emoji)?.reactedByMe ?? false));
  };
  useLayerFocus({ open, container: menuRef, onClose: () => setPickerOpen(false) });
  useEffect(() => { if (!enabled) setPickerOpen(false); }, [enabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div ref={rootRef} className="relative mt-1.5 flex min-h-0 flex-wrap items-center gap-1.5">
      {reactions.filter((item) => item.count > 0 || item.pending).map((reaction) => (
        <button key={reaction.emoji} type="button" disabled={blocked(reaction.emoji)}
          aria-pressed={reaction.reactedByMe} aria-busy={reaction.pending}
          aria-label={`React with ${EMOJI_NAMES[reaction.emoji]}, ${reaction.count} ${reaction.count === 1 ? "person" : "people"}${reaction.pending ? ", waiting for confirmation" : ""}`}
          onClick={() => set(reaction.emoji)}
          className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[14px] transition-colors disabled:cursor-not-allowed ${reaction.reactedByMe ? "border-accent/50 bg-accent-soft text-accent-strong" : "border-line bg-paper-raised text-ink-soft hover:bg-sage"} ${reaction.pending ? "opacity-70" : ""}`}>
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="font-mono text-[12px] font-medium">{reaction.count}</span>
          {reaction.pending ? <Loader2 className="cr-spin h-3.5 w-3.5" aria-hidden="true" /> : null}
        </button>
      ))}
      {enabled ? (
        <button type="button" onClick={() => setPickerOpen((value) => !value)}
          aria-expanded={open} aria-haspopup="menu" aria-label="Add reaction" title="Add reaction"
          className="cr-reaction-add absolute left-0 top-0 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-dashed border-line-strong text-ink-faint opacity-0 transition-colors hover:bg-sage hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">
          <SmilePlus className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      {open ? (
        <div ref={menuRef} role="menu" tabIndex={-1} aria-label="Choose a reaction"
          onKeyDown={(event) => {
            if (event.key === "Tab") { setPickerOpen(false); return; }
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const nodes = focusableElements(event.currentTarget);
            const current = nodes.indexOf(document.activeElement as HTMLElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1
              : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + nodes.length) % nodes.length;
            nodes[next]?.focus();
          }}
          className="cr-pop absolute bottom-full left-0 z-30 mb-1.5 flex max-w-[calc(100vw-100px)] gap-0.5 rounded-full border border-line bg-paper-raised p-1 shadow-lg">
          {REACTION_EMOJIS.map((emoji) => (
            <button key={emoji} type="button" role="menuitemcheckbox" disabled={blocked(emoji)}
              aria-checked={reactions.find((item) => item.emoji === emoji)?.reactedByMe ?? false}
              aria-label={`React with ${EMOJI_NAMES[emoji]}`}
              onClick={() => { if (!blocked(emoji)) { set(emoji); setPickerOpen(false); } }}
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[18px] transition-colors hover:bg-sage aria-checked:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40">
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

import { ArrowDown } from "lucide-react";
import type { UnreadButtonProps } from "../../contract.js";

/** Forward navigation to the latest messages when the application exposes unread state. */
export function UnreadButton({ count, visible, onActivate }: UnreadButtonProps) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onActivate}
      className="cr-pop pointer-events-auto flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-paper-raised px-3.5 text-[13px] font-medium text-ink shadow-[0_4px_16px_oklch(0.32_0.015_140/0.14)] transition-colors hover:bg-sage"
    >
      <ArrowDown className="h-4 w-4 text-accent" aria-hidden="true" />
      {count} new {count === 1 ? "message" : "messages"}
      <span className="text-ink-faint">· Jump to latest</span>
    </button>
  );
}

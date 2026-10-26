import type { TypingIndicatorProps } from "../../contract.js";

function typingLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length - 2 === 1 ? "other" : "others"} are typing`;
}

/** Reserve a fixed-height typing slot to prevent layout movement. */
export function TypingIndicator({ view }: TypingIndicatorProps) {
  const names = view.users.map((user) => user.displayName);
  const label = typingLabel(names);
  return (
    <div className="flex h-6 items-center" aria-live="polite">
      {label ? (
        <p className="cr-fade-in flex items-center gap-1.5 text-[12.5px] text-ink-faint">
          <span className="flex items-end gap-0.5" aria-hidden="true">
            <span className="cr-typing-dot h-1 w-1 rounded-full bg-ink-faint" />
            <span className="cr-typing-dot h-1 w-1 rounded-full bg-ink-faint" />
            <span className="cr-typing-dot h-1 w-1 rounded-full bg-ink-faint" />
          </span>
          {label}…
        </p>
      ) : null}
    </div>
  );
}

import type { ReactNode } from "react";
import type { HighlightRange } from "../contract.js";

interface HighlightTextProps {
  readonly text: string;
  readonly matches: readonly HighlightRange[];
}

/** Render plain text with highlights at UTF-16 ranges in the original string. */
export function HighlightText({ text, matches }: HighlightTextProps) {
  if (matches.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((range, index) => {
    const start = Math.max(0, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (end > start) {
      parts.push(
        <mark key={`m-${index}`} className="cr-mark">
          {text.slice(start, end)}
        </mark>,
      );
    }
    cursor = Math.max(cursor, end);
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { CodeBlockProps } from "../../contract.js";
import { HighlightText } from "../HighlightText.jsx";

type CopyState = "idle" | "copied" | "failed";

/** Preserve code whitespace and show copy confirmation only after clipboard success. */
export function CodeBlock({ source, language, matches, onCopy, collapsed = false }: CodeBlockProps & { readonly collapsed?: boolean }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = () => {
    void onCopy().then((result) => {
      setCopyState(result.ok ? "copied" : "failed");
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyState("idle"), 2000);
    });
  };

  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-paper-sunken">
      <figcaption className="flex h-9 items-center justify-between border-b border-line bg-paper-raised pl-3 pr-1.5">
        <span className="cr-label text-ink-faint">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors hover:bg-sage hover:text-ink"
          aria-label={`Copy ${language} code`}
          aria-live="polite"
        >
          {copyState === "copied" ? (
            <>
              <Check className="h-3.5 w-3.5 text-ok" aria-hidden="true" />
              <span className="text-ok">Copied</span>
            </>
          ) : copyState === "failed" ? (
            <>
              <Copy className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
              <span className="text-danger">Copy failed</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy code
            </>
          )}
        </button>
      </figcaption>
      <pre className={`cr-code cr-scroll overflow-x-auto px-3.5 py-3 text-ink ${collapsed ? "cr-folded-code" : ""}`}>
        <code>
          <HighlightText text={source} matches={matches} />
        </code>
      </pre>
    </figure>
  );
}

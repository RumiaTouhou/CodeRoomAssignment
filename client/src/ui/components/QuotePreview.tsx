import { CornerUpLeft } from "lucide-react";
import type { QuotePreviewProps } from "../../contract.js";

/** Display a reply summary and enable navigation when its target is retained. */
export function QuotePreview({ view, onNavigate }: QuotePreviewProps) {
  const expired = view.availability === "expired";

  const inner = (
    <>
      <span className="flex max-w-full flex-wrap items-center gap-1.5">
        <CornerUpLeft className={`h-3.5 w-3.5 ${expired ? "text-ink-faint" : "text-accent"}`} aria-hidden="true" />
        <span className={`cr-label ${expired ? "text-ink-faint" : "text-accent-strong"}`}>
          {view.author.displayName}
        </span>
        <span className="cr-label text-ink-faint">{view.kind === "code" ? "code" : ""}</span>
      </span>
      <span className="block max-w-full break-words text-[14px] leading-relaxed text-ink-soft">
        {view.previewText}
      </span>
      {expired ? <span className="text-[12px] text-ink-faint">Original message is no longer retained. Preview preserved.</span> : null}
    </>
  );

  const base =
    "mb-1.5 flex w-fit max-w-full flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left";
  if (expired) {
    return (
      <div className={`${base} cursor-default border-dashed border-line bg-paper`} aria-disabled="true">
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onNavigate}
      className={`${base} cursor-pointer border-line bg-paper transition-colors hover:bg-sage`}
      aria-label={`Jump to message from ${view.author.displayName}`}
    >
      {inner}
    </button>
  );
}

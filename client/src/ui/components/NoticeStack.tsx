import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import type { NoticeView } from "../../contract.js";

interface NoticeStackProps {
  readonly notices: readonly NoticeView[];
  readonly onDismiss: (id: string) => void;
}

const toneBySeverity = {
  info: { box: "border-line bg-paper-raised text-ink-soft", icon: <Info className="h-4 w-4 text-info" aria-hidden="true" /> },
  warning: { box: "border-warn/40 bg-warn-soft text-ink", icon: <AlertTriangle className="h-4 w-4 text-warn" aria-hidden="true" /> },
  error: { box: "border-danger/40 bg-danger-soft text-ink", icon: <XCircle className="h-4 w-4 text-danger" aria-hidden="true" /> },
} as const;

/** Non-blocking notices below the header. */
export function NoticeStack({ notices, onDismiss }: NoticeStackProps) {
  if (notices.length === 0) return null;
  return (
    <div className="border-b border-line bg-paper px-3 py-2 sm:px-4">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-1.5">
        {notices.map((notice) => {
          const tone = toneBySeverity[notice.severity];
          return (
            <div
              key={notice.id}
              role={notice.severity === "error" ? "alert" : "status"}
              className={`cr-fade-in flex items-start gap-2 rounded-lg border px-3 py-2 text-[13.5px] ${tone.box}`}
            >
              <span className="mt-0.5 shrink-0">{tone.icon}</span>
              <p className="min-w-0 flex-1 leading-snug">{notice.message}</p>
              {notice.dismissible ? (
                <button
                  type="button"
                  onClick={() => onDismiss(notice.id)}
                  className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-sage hover:text-ink"
                  aria-label="Dismiss notice"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

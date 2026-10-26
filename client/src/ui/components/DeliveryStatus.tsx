import { AlertCircle, Check, Loader2, RotateCcw, Undo2, XCircle } from "lucide-react";
import type { DeliveryView, OperationId } from "../../contract.js";

interface DeliveryStatusProps {
  readonly delivery: DeliveryView;
  readonly operationId: OperationId | null;
  readonly canRestoreToComposer: boolean;
  readonly onRetryMessage: (operationId: OperationId) => void;
  readonly onRestoreToComposer: (operationId: OperationId) => void;
}

const retryButton =
  "ml-1 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-medium underline underline-offset-2 transition-colors hover:opacity-80";

/** Server acknowledgement is separate from delivery or read status.
 * A timed-out operation remains unknown until the server confirms its outcome. */
export function DeliveryStatus({
  delivery,
  operationId,
  canRestoreToComposer,
  onRetryMessage,
  onRestoreToComposer,
}: DeliveryStatusProps) {
  const restore = operationId !== null && canRestoreToComposer ? (
    <button
      type="button"
      onClick={() => onRestoreToComposer(operationId)}
      className={`${retryButton} text-ink-soft no-underline hover:bg-sage`}
      aria-label="Restore message to composer"
    >
      <Undo2 className="h-3 w-3" aria-hidden="true" />
      Edit &amp; resend
    </button>
  ) : null;

  switch (delivery.phase) {
    case "incoming":
      return null;
    case "confirmed":
      return (
        <span className="flex items-center text-ink-faint" title="Sent to server" aria-label="Sent to server">
          <Check className="h-3 w-3" aria-hidden="true" />
        </span>
      );
    case "sending":
      return (
        <span className="flex items-center gap-1.5 text-ink-faint">
          <Loader2 className="cr-spin h-3 w-3" aria-hidden="true" />
          <span className="text-[12px]">Sending…</span>
        </span>
      );
    case "unknown":
      return (
        <span className="flex flex-wrap items-center gap-1 text-warn">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="text-[12px] font-medium">Confirmation not received</span>
          {delivery.canRetry && operationId !== null ? (
            <button
              type="button"
              onClick={() => onRetryMessage(operationId)}
              className={retryButton}
              aria-label="Retry sending message"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Retry
            </button>
          ) : null}
          {restore}
        </span>
      );
    case "rejected":
      return (
        <span className="flex flex-wrap items-center gap-1.5 text-danger">
          <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="text-[12px] font-medium">
            Couldn’t send this message — {delivery.error.message}
          </span>
          {restore}
        </span>
      );
    case "accepted-outside-history":
      return (
        <span className="flex items-center gap-1.5 text-ink-faint">
          <Check className="h-3 w-3" aria-hidden="true" />
          <span className="text-[12px]">Received — outside the retained history window</span>
        </span>
      );
  }
}

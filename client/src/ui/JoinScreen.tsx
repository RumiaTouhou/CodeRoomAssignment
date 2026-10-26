import { SquareTerminal, Loader2, ShieldAlert } from "lucide-react";
import type { JoinScreenProps } from "../contract.js";
import { LIMITS } from "../contract.js";

/** Controlled room entry form with submitting and error states. */
export function JoinScreen({ view, onDisplayNameChange, onAdminPasswordChange, onUseSavedIdentityChange, onSubmit }: JoinScreenProps) {
  const submitting = view.phase === "submitting";
  const canJoin = view.displayName.trim().length > 0 && !submitting;

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-paper px-4 py-10">
      <div className="cr-fade-up w-full max-w-sm">
        {/* Brand mark */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-strong">
            <SquareTerminal className="h-6 w-6" aria-hidden="true" />
          </span>
          <p className="cr-label mb-2 text-ink-faint">CodeRoom</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Welcome to CodeRoom
          </h1>
          <p className="mt-2 text-[15px] text-ink-soft">
            A focused space for real-time collaboration.
          </p>
        </div>

        <form
          className="rounded-2xl border border-line bg-paper-raised p-5 shadow-[0_1px_2px_oklch(0.32_0.015_140/0.06)]"
          onSubmit={(event) => {
            event.preventDefault();
            if (canJoin) onSubmit();
          }}
        >
          <label htmlFor="display-name" className="cr-label mb-2 block text-ink-soft">
            Display name
          </label>
          <input
            id="display-name"
            type="text"
            autoComplete="nickname"
            autoFocus
            maxLength={LIMITS.nicknameCodePoints * 2}
            placeholder="e.g. Alice"
            value={view.displayName}
            disabled={submitting}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            aria-invalid={view.phase === "error"}
            aria-describedby={view.phase === "error" && view.error ? "join-error" : "join-note"}
            className="h-11 w-full rounded-lg border border-line-strong bg-paper px-3 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:opacity-60"
          />

          {view.restoreAvailable ? (
            <div className="mt-4 rounded-lg border border-line bg-paper px-3 py-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink-soft">
                <input
                  type="checkbox"
                  checked={view.useSavedIdentity ?? true}
                  disabled={submitting}
                  onChange={(event) => onUseSavedIdentityChange?.(event.target.checked)}
                  aria-describedby="saved-identity-note"
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                Use saved guest identity
              </label>
              <p id="saved-identity-note" className="mt-1 pl-6 text-[12px] leading-snug text-ink-faint">Turn off to join as a different guest.</p>
            </div>
          ) : null}

          <div className="mt-4">
            <label htmlFor="admin-password" className="cr-label mb-2 block text-ink-soft">
              Admin password <span className="font-sans text-[11px] normal-case tracking-normal text-ink-faint">(optional)</span>
            </label>
            <input
              id="admin-password"
              type="password"
              maxLength={256}
              autoComplete="current-password"
              value={view.adminPassword ?? ""}
              disabled={submitting}
              onChange={(event) => onAdminPasswordChange?.(event.target.value)}
              aria-describedby="admin-password-note"
              className="h-11 w-full rounded-lg border border-line-strong bg-paper px-3 text-[15px] text-ink outline-none transition-colors focus:border-accent disabled:opacity-60"
            />
            <p id="admin-password-note" className="mt-1.5 text-[12px] leading-snug text-ink-faint">
              Leave empty to join as a guest. Admins can manage the room’s pinned message.
            </p>
          </div>

          {view.phase === "error" && view.error ? (
            <p
              id="join-error"
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13.5px] text-danger"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {view.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={!canJoin}
            className="mt-4 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent text-[15px] font-medium text-ink-invert transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="cr-spin h-4 w-4" aria-hidden="true" />
                Joining…
              </>
            ) : (
              "Join room"
            )}
          </button>
        </form>

        <p id="join-note" className="mt-4 text-center text-[12.5px] leading-relaxed text-ink-faint">
          Please don&rsquo;t share passwords or API keys in the room.
        </p>
      </div>
    </div>
  );
}

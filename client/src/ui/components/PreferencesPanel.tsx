import { useRef } from "react";
import { createPortal } from "react-dom";
import { Volume2, X } from "lucide-react";
import type { PreferencesProps, SoundView } from "../../contract.js";
import { useLayerFocus } from "../useLayerFocus.js";

interface PreferencesPanelProps extends PreferencesProps {
  readonly onClose: () => void;
}

function playbackNote(sound: SoundView): { text: string; tone: string } | null {
  switch (sound.playback) {
    case "not-enabled":
      return sound.mode === "incoming"
        ? null
        : { text: "Turn on incoming sound to enable previews.", tone: "text-ink-faint" };
    case "unverified":
      return { text: "Sound is on. The next incoming message will try playback, or use Preview to test it now.", tone: "text-ink-soft" };
    case "ready":
      return { text: "Sound is ready.", tone: "text-ok" };
    case "blocked":
      return { text: "The browser blocked playback. Click or type on this page, or use Preview, then try another message.", tone: "text-warn" };
    case "unavailable":
      return { text: "Sound isn’t available in this browser.", tone: "text-danger" };
  }
}

/** Controlled sound, send shortcut and typing preferences. */
export function PreferencesPanel({ preferences, sound, callbacks, onClose }: PreferencesPanelProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  useLayerFocus({ open: true, container: panelRef, initialFocus: closeRef, modal: true, onClose });

  const note = playbackNote(sound);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/25 p-3 backdrop-blur-[2px] sm:items-center">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
        className="cr-pop cr-scroll max-h-[calc(100dvh-24px)] w-full max-w-sm overflow-y-auto rounded-2xl border border-line bg-paper-raised p-5 shadow-[0_12px_40px_oklch(0.32_0.015_140/0.18)]"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="preferences-title" className="text-[16px] font-semibold text-ink">
            Preferences
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sage hover:text-ink"
            aria-label="Close preferences"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Incoming sound */}
        <section aria-labelledby="pref-sound" className="mb-5">
          <h3 id="pref-sound" className="cr-label mb-2 text-ink-soft">
            Incoming sound
          </h3>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="Incoming sound" className="flex rounded-lg bg-sage/60 p-0.5">
              {(["off", "incoming"] as const).map((mode) => {
                const active = preferences.soundMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => callbacks.onSoundModeChange(mode)}
                    className={`h-8 min-w-16 cursor-pointer rounded-md px-3 text-[13px] font-medium transition-colors ${
                      active
                        ? "bg-paper-raised text-ink shadow-[0_1px_2px_oklch(0.32_0.015_140/0.08)]"
                        : "text-ink-faint hover:text-ink"
                    }`}
                  >
                    {mode === "off" ? "Off" : "On"}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => callbacks.onPreviewSound()}
              disabled={sound.mode === "off" || sound.playback === "unavailable"}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-ink-soft transition-colors hover:bg-sage disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
              Preview
            </button>
          </div>
          {note ? <p className={`mt-2 text-[12.5px] ${note.tone}`}>{note.text}</p> : null}
        </section>

        <section aria-labelledby="pref-member-sounds" className="mb-5 border-b border-line pb-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 id="pref-member-sounds" className="text-[14px] font-medium text-ink">Member activity sounds</h3>
              <p className="mt-0.5 text-[12.5px] leading-snug text-ink-faint">
                Play a sound when someone joins, leaves or returns. Incoming sound must be on.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.memberSounds ?? true}
              aria-labelledby="pref-member-sounds"
              onClick={() => callbacks.onMemberSoundsChange(!(preferences.memberSounds ?? true))}
              className={`relative flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors ${(preferences.memberSounds ?? true) ? "bg-accent" : "bg-line-strong"}`}
            >
              <span className={`h-4.5 w-4.5 rounded-full bg-paper-raised shadow-sm transition-transform ${(preferences.memberSounds ?? true) ? "translate-x-[19px]" : "translate-x-[3px]"}`} />
            </button>
          </div>
        </section>

        <section aria-labelledby="pref-reading-size" className="mb-5">
          <h3 id="pref-reading-size" className="cr-label mb-2 text-ink-soft">Reading size</h3>
          <div role="group" aria-label="Reading size" className="flex rounded-lg bg-sage/60 p-0.5">
            {(["standard", "large", "larger"] as const).map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={(preferences.readingSize ?? "standard") === size}
                onClick={() => callbacks.onReadingSizeChange(size)}
                className={`h-9 min-w-0 flex-1 cursor-pointer rounded-md px-2 text-[13px] font-medium transition-colors ${(preferences.readingSize ?? "standard") === size ? "bg-paper-raised text-ink shadow-sm" : "text-ink-faint hover:text-ink"}`}
              >
                {size === "standard" ? "Standard" : size === "large" ? "Large" : "Larger"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12.5px] text-ink-faint">Adjust message text, code and the composer.</p>
        </section>

        {/* Send shortcut */}
        <section aria-labelledby="pref-shortcut" className="mb-5">
          <h3 id="pref-shortcut" className="cr-label mb-2 text-ink-soft">
            Send shortcut
          </h3>
          <div role="group" aria-label="Send shortcut" className="flex rounded-lg bg-sage/60 p-0.5">
            {(
              [
                { value: "enter", label: "Enter to send" },
                { value: "mod-enter", label: "Ctrl/⌘+Enter to send" },
              ] as const
            ).map((option) => {
              const active = preferences.textSendShortcut === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => callbacks.onShortcutChange(option.value)}
                  className={`h-8 flex-1 cursor-pointer rounded-md px-2 text-[12.5px] font-medium transition-colors ${
                    active
                      ? "bg-paper-raised text-ink shadow-[0_1px_2px_oklch(0.32_0.015_140/0.08)]"
                      : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* Typing sharing */}
        <section aria-labelledby="pref-typing">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 id="pref-typing" className="text-[14px] font-medium text-ink">
                Share when I’m typing
              </h3>
              <p className="text-[12.5px] text-ink-faint">Others see a subtle typing indicator.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences.shareTyping}
              aria-labelledby="pref-typing"
              onClick={() => callbacks.onShareTypingChange(!preferences.shareTyping)}
              className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                preferences.shareTyping ? "bg-accent" : "bg-line-strong"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-paper-raised shadow transition-transform ${
                  preferences.shareTyping ? "translate-x-5" : "translate-x-0"
                }`}
                aria-hidden="true"
              />
            </button>
          </div>
        </section>
      </div>
    </div>, document.body
  );
}

import type { LocalPreferences, SoundView } from "../../../shared/ui.js";
import { LIMITS } from "../../../shared/limits.js";

export interface AudioPort {
  currentTime: number;
  preload?: string;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener?(type: "error", listener: () => void): void;
  removeEventListener?(type: "error", listener: () => void): void;
}
export interface SoundOptions {
  readonly onChange?: () => void;
  readonly createAudio?: (source: string) => AudioPort;
  readonly source?: string;
  readonly enterSource?: string;
  readonly leaveSource?: string;
  readonly now?: () => number;
  readonly cooldownMs?: number;
}

export type NotificationSound = "message" | "joined" | "returned" | "left";

export class SoundService {
  private mode: LocalPreferences["soundMode"] = "off";
  private playback: SoundView["playback"] = "not-enabled";
  private audio: AudioPort | null = null;
  private audioSource: string | null = null;
  private generation = 0;
  private playAttempt = 0;
  private playPending = false;
  private lastIncomingAt = Number.NEGATIVE_INFINITY;
  private readonly createAudio: (source: string) => AudioPort;
  private readonly source: string;
  private readonly enterSource: string;
  private readonly leaveSource: string;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly onChange: () => void;
  private readonly onError = () => {
    if (this.mode !== "incoming") return;
    this.playAttempt++;
    this.playPending = false;
    this.setPlayback("unavailable");
  };

  constructor(options: SoundOptions = {}) {
    this.createAudio = options.createAudio ?? ((source) => new Audio(source));
    this.source = options.source ?? "/sounds/NewMsg.wav";
    this.enterSource = options.enterSource ?? "/sounds/EnterRoom.wav";
    this.leaveSource = options.leaveSource ?? "/sounds/LeaveRoom.wav";
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? LIMITS.soundCooldownMs;
    this.onChange = options.onChange ?? (() => {});
  }

  view(): SoundView {
    return { mode: this.mode, playback: this.playback };
  }

  restore(mode: LocalPreferences["soundMode"]): void {
    this.mode = mode;
    this.generation++;
    this.playAttempt++;
    this.playPending = false;
    this.stop();
    this.lastIncomingAt = Number.NEGATIVE_INFINITY;
    this.setPlayback(mode === "incoming" ? "unverified" : "not-enabled");
  }

  async setMode(mode: LocalPreferences["soundMode"]): Promise<void> {
    this.mode = mode;
    this.generation++;
    this.playAttempt++;
    this.playPending = false;
    if (mode === "off") {
      this.stop();
      this.setPlayback("not-enabled");
      return;
    }
    await this.play();
  }

  async preview(): Promise<void> {
    if (this.mode !== "incoming") return;
    await this.play();
  }

  receive(kind: NotificationSound = "message"): void {
    const source = kind === "left" ? this.leaveSource : kind === "message" ? this.source : this.enterSource;
    if (this.mode !== "incoming" || (this.playback === "unavailable" && this.audioSource === source) || this.playPending) return;
    const at = this.now();
    if (at - this.lastIncomingAt < this.cooldownMs) return;
    void this.play(true, source);
  }

  incoming(): void { this.receive(); }

  dispose(): void {
    this.generation++;
    this.playAttempt++;
    this.playPending = false;
    this.stop();
    this.audio?.removeEventListener?.("error", this.onError);
    this.audio = null;
    this.audioSource = null;
    this.mode = "off";
    this.playback = "not-enabled";
    this.lastIncomingAt = Number.NEGATIVE_INFINITY;
  }

  private async play(incoming = false, source = this.source): Promise<void> {
    const generation = this.generation;
    const attempt = ++this.playAttempt;
    this.playPending = true;
    try {
      if (this.audioSource !== source) {
        this.stop();
        this.audio?.removeEventListener?.("error", this.onError);
        this.audio = null;
        this.audioSource = source;
      }
      if (!this.audio) {
        this.audio = this.createAudio(source);
        this.audio.preload = "auto";
        this.audio.addEventListener?.("error", this.onError);
      }
      this.audio.currentTime = 0;
      const playback = this.audio.play();
      await playback;
      if (generation === this.generation && attempt === this.playAttempt && this.mode === "incoming") {
        if (incoming) this.lastIncomingAt = this.now();
        this.setPlayback("ready");
      }
    } catch (error: unknown) {
      if (generation !== this.generation || attempt !== this.playAttempt || this.mode !== "incoming") return;
      const name = error instanceof Error ? error.name : "";
      this.setPlayback(name === "NotAllowedError" ? "blocked" : "unavailable");
    } finally {
      if (generation === this.generation && attempt === this.playAttempt) this.playPending = false;
    }
  }

  private stop(): void {
    try { this.audio?.pause(); if (this.audio) this.audio.currentTime = 0; }
    catch {}
  }

  private setPlayback(playback: SoundView["playback"]): void {
    if (this.playback === playback) return;
    this.playback = playback;
    this.onChange();
  }
}

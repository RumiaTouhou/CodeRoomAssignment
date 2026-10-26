import type { ChatMessage } from "../../../shared/domain.js";
import type { ReadingAnchor } from "../../../shared/persistence.js";
import { messageRenderKey, type TimelineDomBindings, type TimelineView } from "../../../shared/ui.js";

export type NavigationState = Pick<TimelineView, "atBottom" | "unseenIncomingCount" | "navigationMode" | "canReturnToReadingPosition" | "highlightedMessageId">;

export class TimelineController {
  private viewport: HTMLDivElement | null = null;
  private readonly rows = new Map<string, HTMLElement>();
  private readonly refs = new Map<string, (node: HTMLElement | null) => void>();
  private messages: readonly ChatMessage[] = [];
  private keys = new Map<string, string>();
  private epoch: string | null = null;
  private following = true;
  private atBottom = true;
  private mode: TimelineView["navigationMode"] = "following";
  private readonly unseen = new Set<string>();
  private captured: ReadingAnchor | null = null;
  private visible: ReadingAnchor | null = null;
  private returnAnchor: ReadingAnchor | null = null;
  private highlighted: string | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: ResizeObserver | null = null;
  private scrollTarget: number | null = null;
  private signature = "";
  private searching = false;
  private anchorLost = false;
  private readonly attending: () => boolean;

  constructor(private readonly onChange: () => void = () => {}, options: { attention?: () => boolean } = {}) {
    this.attending = options.attention ?? (() => typeof document === "undefined" || (!document.hidden && document.hasFocus()));
    this.signature = JSON.stringify(this.state());
  }

  readonly bindings: TimelineDomBindings = {
    viewportRef: node => {
      this.observer?.disconnect();
      if (typeof window !== "undefined") window.removeEventListener("focus", this.refreshAttention);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.refreshAttention);
      this.viewport = node;
      if (node) {
        if (typeof window !== "undefined") window.addEventListener("focus", this.refreshAttention);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.refreshAttention);
      }
      if (node && typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => {
          if (this.following) this.writeTop(Number.POSITIVE_INFINITY);
          else if (this.visible) this.restoreAnchor(this.visible);
          this.visible = this.captureAnchor();
          this.publish();
        });
        this.observer.observe(node);
        if (node.firstElementChild) this.observer.observe(node.firstElementChild);
      }
    },
    rowRef: key => {
      let ref = this.refs.get(key);
      if (!ref) {
        ref = node => { if (node) this.rows.set(key, node); else this.rows.delete(key); };
        this.refs.set(key, ref);
      }
      return ref;
    },
    onScroll: () => {
      const node = this.viewport;
      if (!node) return;
      this.atBottom = this.nearBottom();
      if (this.scrollTarget !== null && Math.abs(node.scrollTop - this.scrollTarget) <= 1) {
        this.scrollTarget = null;
      } else {
        this.scrollTarget = null;
        this.following = this.atBottom;
        if (this.atBottom) { this.mode = "following"; if (this.attending()) this.unseen.clear(); }
        else if (this.mode === "following") this.mode = "reading";
      }
      this.visible = this.captureAnchor();
      this.publish();
    },
  };

  state(): NavigationState {
    return {
      atBottom: this.atBottom, unseenIncomingCount: this.unseen.size,
      navigationMode: this.mode, canReturnToReadingPosition: this.returnAnchor !== null,
      highlightedMessageId: this.highlighted,
    };
  }

  beforeUpdate(): void { this.captured = this.following ? null : this.captureAnchor(); }

  afterUpdate({ epochId, messages, newIncomingIds = [] }: {
    readonly epochId: string;
    readonly messages: readonly ChatMessage[];
    readonly newIncomingIds?: readonly string[];
  }): void {
    if (this.epoch !== epochId) {
      this.epoch = epochId; this.following = true; this.mode = "following";
      this.captured = null; this.visible = null; this.returnAnchor = null;
      this.highlighted = null; this.unseen.clear(); this.searching = false; this.anchorLost = false;
      if (this.highlightTimer) clearTimeout(this.highlightTimer);
    }
    this.messages = messages;
    this.keys = new Map(messages.map(message => [message.id, messageRenderKey(message)]));
    for (const id of this.unseen) if (!this.keys.has(id)) this.unseen.delete(id);
    for (const id of newIncomingIds) if (this.keys.has(id)) this.unseen.add(id);
    if (this.following) this.writeTop(Number.POSITIVE_INFINITY);
    else {
      const anchor = this.captured ?? this.visible;
      if (anchor && !this.restoreAnchor(anchor)) {
        this.anchorLost = true;
        const first = messages[0];
        if (first && this.viewport) this.writeTop(0);
      }
    }
    if (this.following && this.atBottom && this.attending()) this.unseen.clear();
    this.captured = null;
    this.visible = this.captureAnchor();
    for (const key of this.refs.keys()) if (!this.rows.has(key)) this.refs.delete(key);
    this.publish();
  }

  jumpToMessage(id: string, reason: "search" | "quote"): boolean {
    const key = this.keys.get(id), row = key ? this.rows.get(key) : null;
    if (!row || !this.viewport) return false;
    if (!this.returnAnchor) this.returnAnchor = this.captureAnchor();
    this.following = false; this.mode = reason; this.searching = false;
    this.writeTop(this.viewport.scrollTop + row.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top - Math.min(80, this.viewport.clientHeight / 4));
    this.highlighted = id;
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => { this.highlighted = null; this.publish(); }, 2400);
    this.visible = this.captureAnchor();
    this.publish();
    return true;
  }

  jumpToLatest(): void {
    this.following = true; this.mode = "following"; this.returnAnchor = null; this.searching = false;
    this.highlighted = null; this.unseen.clear();
    this.writeTop(Number.POSITIVE_INFINITY);
    this.visible = this.captureAnchor(); this.publish();
  }

  restoreReadingPosition(): boolean {
    const anchor = this.returnAnchor;
    this.returnAnchor = null; this.searching = false;
    if (!anchor || !this.restoreAnchor(anchor)) { this.publish(); return false; }
    this.following = this.atBottom; this.mode = this.atBottom ? "following" : "reading";
    this.highlighted = null;
    if (this.following && this.attending()) this.unseen.clear();
    this.visible = this.captureAnchor(); this.publish();
    return true;
  }

  beginSearch(): void {
    if (!this.returnAnchor) this.returnAnchor = this.captureAnchor();
    this.searching = true; this.following = false; this.mode = "search";
    this.publish();
  }

  cancelSearch(): boolean {
    if (!this.searching) return true;
    this.searching = false;
    if (this.returnAnchor) return this.restoreReadingPosition();
    this.following = true; this.mode = "following"; this.writeTop(Number.POSITIVE_INFINITY);
    this.refreshAttention(); return true;
  }

  takeAnchorLoss(): boolean {
    const lost = this.anchorLost; this.anchorLost = false; return lost;
  }

  readonly refreshAttention = (): void => {
    if (this.following && this.nearBottom() && this.attending()) this.unseen.clear();
    this.publish();
  };

  dispose(): void {
    this.observer?.disconnect(); this.observer = null;
    if (typeof window !== "undefined") window.removeEventListener("focus", this.refreshAttention);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.refreshAttention);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.rows.clear(); this.refs.clear(); this.viewport = null;
  }

  private nearBottom(): boolean {
    return !this.viewport || this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop <= 48;
  }

  private writeTop(top: number): void {
    if (!this.viewport) return;
    const value = Math.max(0, Math.min(top, Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight)));
    if (Math.abs(this.viewport.scrollTop - value) > 0.5) {
      this.scrollTarget = value;
      this.viewport.scrollTop = value;
    }
    this.atBottom = this.nearBottom();
  }

  private captureAnchor(): ReadingAnchor | null {
    if (!this.viewport || !this.epoch) return null;
    const viewport = this.viewport.getBoundingClientRect();
    for (const message of this.messages) {
      const row = this.rows.get(messageRenderKey(message));
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom > viewport.top && rect.top < viewport.bottom) return { epochId: this.epoch, messageId: message.id, offsetPx: rect.top - viewport.top };
    }
    return null;
  }

  private restoreAnchor(anchor: ReadingAnchor): boolean {
    if (anchor.epochId !== this.epoch || !this.viewport) return false;
    const key = this.keys.get(anchor.messageId), row = key ? this.rows.get(key) : null;
    if (!row) return false;
    this.writeTop(this.viewport.scrollTop + row.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top - anchor.offsetPx);
    return true;
  }

  private publish(): void {
    const signature = JSON.stringify(this.state());
    if (signature !== this.signature) { this.signature = signature; this.onChange(); }
  }
}

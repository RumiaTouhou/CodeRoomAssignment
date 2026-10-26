import type { ChatMessage, MemberEvent, MessageReceipt, RoomSnapshot } from "../../../shared/domain.js";
import { rawContent } from "../../../shared/domain.js";
import type { HttpPort } from "../../../shared/ports.js";
import type { SessionCredential } from "../../../shared/http.js";
import type { OutboxEntry, StoredBookmark } from "../../../shared/persistence.js";
import type { ClientEvent, ServerEvent } from "../../../shared/ws.js";
import type { AppView, ChatCallbacks, ChatView, ComposerDomBindings, ComposerDraft, ConnectionView, DraftIntent, JoinView, LocalPreferences, MessageView, NoticeView, QuoteView, SearchView, SubmitIntent, TimelineDomBindings, TimelineItem, TimelineView } from "../../../shared/ui.js";
import { messageRenderKey } from "../../../shared/ui.js";
import { LIMITS, REACTION_EMOJIS } from "../../../shared/limits.js";
import { snapshotInvariantErrors } from "../../../shared/invariants.js";
import { utf8Bytes } from "../../../shared/validation.js";
import { BrowserStorage, defaultPreferences, emptyDraft } from "../services/storage.js";
import { SoundService } from "../services/sound.js";
import { backendOrigin, HttpClient, HttpFailure } from "../services/http.js";
import { RealtimeClient, type RealtimeAdapter, type RealtimeHandlers } from "../services/realtime.js";
import { TimelineController } from "./navigation.js";
import { advanceDraft, applyRoomDelta, composerDisabledReason, reconcileOutbox } from "./model.js";

export interface ControllerNavigation {
  readonly bindings: TimelineDomBindings;
  state(): Omit<TimelineView, "items">;
  beforeUpdate(): void;
  afterUpdate(input: { epochId: string; messages: readonly ChatMessage[]; newIncomingIds?: readonly string[] }): void;
  jumpToMessage(id: string, reason: "search" | "quote"): boolean;
  jumpToLatest(): void;
  restoreReadingPosition(): boolean;
  dispose(): void;
  beginSearch?(): void;
  cancelSearch?(): boolean;
  takeAnchorLoss?(): boolean;
}
type StoragePort = Pick<BrowserStorage, "readSession" | "writeSession" | "clearSession" | "readDraft" | "writeDraft" | "readOutbox" | "writeOutbox" | "readPreferences" | "writePreferences" | "available"> & Partial<Pick<BrowserStorage, "readRestoreCredential" | "writeRestoreCredential" | "clearRestoreCredential" | "readBookmarks" | "writeBookmarks">>;
type AudioPort = Pick<SoundService, "view" | "restore" | "setMode" | "preview" | "receive" | "dispose">;
export interface ControllerOptions {
  readonly apiOrigin?: string;
  readonly http?: HttpPort;
  readonly storage?: StoragePort;
  readonly sound?: AudioPort;
  readonly transportFactory?: (handlers: RealtimeHandlers) => RealtimeAdapter;
  readonly navigation?: ControllerNavigation;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly isForeground?: () => boolean;
  readonly confirm?: (message: string) => boolean;
}
interface PendingReaction { readonly operationId: string; readonly messageId: string; readonly emoji: typeof REACTION_EMOJIS[number]; readonly sentAt: number }
const emptyHistory = () => ({ retainedCount: 0, limit: LIMITS.historyMessages, serializedBytes: 2, maxSerializedBytes: LIMITS.historyJsonUtf8Bytes, oldestSequence: null, newestSequence: null, persistence: "memory-until-server-restart" as const });
const messageText = (error: unknown): string => error instanceof Error ? error.message : "The request could not be completed.";
const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dayLabel = (at: number): string => dateFormatter.format(at);

export class ChatController {
  private readonly http: HttpPort;
  private readonly storage: StoragePort;
  private readonly sound: AudioPort;
  private readonly transport: RealtimeAdapter;
  private readonly navigation: ControllerNavigation;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly isForeground: () => boolean;
  private readonly typingDeadlines = new Map<string, number>();
  private readonly confirm: (message: string) => boolean;
  private readonly listeners = new Set<() => void>();
  private active = false;
  private lifecycle = 0;
  private credential: SessionCredential | null = null;
  private room: RoomSnapshot | null = null;
  private join: JoinView = { displayName: "", adminPassword: "", phase: "idle", error: null };
  private connection: ConnectionView = { phase: "connecting" };
  private preferences: LocalPreferences;
  private draft: ComposerDraft = emptyDraft();
  private reply: QuoteView | null = null;
  private recovery: ComposerDraft | null = null;
  private outbox: OutboxEntry[] = [];
  private readonly receipts = new Map<string, MessageReceipt>();
  private readonly attempts = new Map<string, number>();
  private readonly reactions = new Map<string, PendingReaction>();
  private search: SearchView = { phase: "closed", query: "" };
  private searchGeneration = 0;
  private searchAbort: AbortController | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private joinAbort: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private composing = false;
  private focused = false;
  private lastEdit = 0;
  private lastTypingSent = 0;
  private typing = false;
  private synchronizing = false;
  private composerError: string | null = null;
  private notices: NoticeView[] = [];
  private readonly incomingIds = new Set<string>();
  private readonly expandedKeys = new Set<string>();
  private bookmarks: StoredBookmark[] = [];
  private bookmarksOpen = false;
  private pendingPin: { operationId: string; messageId: string | null; sentAt: number } | null = null;
  private readonly memberEventIds = new Set<string>();
  private memberEvents: readonly MemberEvent[] = [];
  private activity: { id: string; displayName: string; kind: "joined" | "left" | "returned"; expiresAt: number }[] = [];
  private deferredJump: { id: string; reason: "search" | "quote" } | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private projection: AppView;

  constructor(options: ControllerOptions = {}) {
    const origin = options.apiOrigin ?? backendOrigin();
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonicNow ?? options.now ?? (() => performance.now());
    this.isForeground = options.isForeground ?? (() => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus());
    this.confirm = options.confirm ?? (message => window.confirm(message));
    this.http = options.http ?? new HttpClient(origin);
    this.storage = options.storage ?? new BrowserStorage(origin);
    this.join = { ...this.join, restoreAvailable: !!this.storage.readRestoreCredential?.(), useSavedIdentity: true };
    this.preferences = { ...defaultPreferences(), ...this.storage.readPreferences() };
    this.sound = options.sound ?? new SoundService({ onChange: () => this.emit() });
    this.navigation = options.navigation ?? new TimelineController(() => this.emit());
    this.transport = (options.transportFactory ?? (handlers => new RealtimeClient(origin, handlers)))({
      onEvent: event => this.receive(event),
      onOpen: () => { if (this.active && this.connection.phase !== "ended") { this.connection = { phase: "synchronizing" }; this.emit(); } },
      onClose: () => this.disconnected(),
      onInvalid: () => this.notice("protocol", "The connection returned invalid data. Reconnecting safely.", "warning"),
    });
    this.projection = this.project();
  }

  readonly getSnapshot = (): AppView => this.projection;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  readonly composerDom: ComposerDomBindings = { textareaRef: node => { this.textarea = node; } };
  get timelineDom(): TimelineDomBindings { return this.navigation.bindings; }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lifecycle += 1;
    this.sound.restore(this.preferences.soundMode);
    this.clockTimer = setInterval(() => this.tick(), 250);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.online);
      window.addEventListener("offline", this.offline);
      window.addEventListener("pagehide", this.persist);
      window.addEventListener("blur", this.blur);
      window.addEventListener("focus", this.focus);
      document.addEventListener("visibilitychange", this.visibility);
    }
    if (!this.credential) {
      const saved = this.storage.readSession();
      if (saved) this.enter(saved, true);
    } else if (this.connection.phase !== "ended") this.connect();
    this.emit();
  }

  stop(): void {
    if (!this.active) return;
    this.persist();
    this.setTyping(false);
    this.active = false;
    this.lifecycle += 1;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.clearReconnect();
    this.cancelSearch();
    this.deferredJump = null;
    this.joinAbort?.abort();
    this.transport.disconnect();
    this.sound.dispose();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.online);
      window.removeEventListener("offline", this.offline);
      window.removeEventListener("pagehide", this.persist);
      window.removeEventListener("blur", this.blur);
      window.removeEventListener("focus", this.focus);
      document.removeEventListener("visibilitychange", this.visibility);
    }
  }

  flushLayout(): void {
    if (!this.room) return;
    const ids = [...this.incomingIds];
    this.incomingIds.clear();
    this.navigation.afterUpdate({ epochId: this.room.epochId, messages: this.room.messages, newIncomingIds: ids });
    if (this.navigation.takeAnchorLoss?.()) this.notice("navigation", "The message anchoring this reading position is no longer retained. The closest available position is shown.", "info");
    if (this.deferredJump && this.connection.phase === "ready") {
      const target = this.deferredJump; this.deferredJump = null;
      this.jump(target.id, target.reason);
    }
  }

  readonly onJoinDisplayNameChange = (value: string): void => { this.join = { ...this.join, displayName: value, phase: "idle", error: null }; this.emit(); };
  readonly onJoinAdminPasswordChange = (value: string): void => { this.join = { ...this.join, adminPassword: value, phase: "idle", error: null }; this.emit(); };
  readonly onJoinUseSavedIdentityChange = (enabled: boolean): void => { this.join = { ...this.join, useSavedIdentity: enabled, phase: "idle", error: null }; this.emit(); };
  readonly onJoinSubmit = (): void => { void this.joinRoom(); };

  readonly callbacks: ChatCallbacks = {
    onRetryConnection: () => { if (this.credential && this.connection.phase !== "ended") { this.reconnectAttempt = 0; this.connect(); } },
    onLeaveRoom: () => { void this.leave(); },
    onReturnToJoin: () => this.returnToJoin(),
    onDraftIntent: intent => this.changeDraft(intent),
    onSubmit: intent => this.submit(intent),
    onComposerKey: input => {
      if (input.isComposing || input.legacyKeyCode === 229 || this.composing || input.key !== "Enter" || input.altKey) return false;
      const modifier = input.ctrlKey || input.metaKey;
      const send = this.draft.mode === "code" || this.preferences.textSendShortcut === "mod-enter" ? modifier && !input.shiftKey : !modifier && !input.shiftKey;
      if (!send) return false;
      this.submit({ draftRevision: this.draft.revision, trigger: "shortcut" });
      return true;
    },
    onCompositionChange: active => { this.composing = active; this.emit(); },
    onComposerFocusChange: focused => { this.focused = focused; if (!focused) this.setTyping(false); },
    onReply: id => this.selectReply(id),
    onSetReaction: (id, emoji, active) => this.setReaction(id, emoji, active),
    onRetryMessage: operationId => this.retry(operationId),
    onRestoreToComposer: operationId => this.restore(operationId),
    onCopyCode: async source => {
      if (!navigator.clipboard?.writeText) return { ok: false, reason: "unavailable" };
      try { await navigator.clipboard.writeText(source); return { ok: true }; }
      catch { return { ok: false, reason: "denied" }; }
    },
    onJumpToMessage: (id, reason) => {
      this.deferredJump = null;
      if (reason === "search" && this.search.phase === "results" && this.room
        && !this.room.messages.some(message => message.id === id)
        && this.search.response.asOfRevision > this.room.revision) {
        this.deferredJump = { id, reason }; this.synchronize(); return;
      }
      this.jump(id, reason);
    },
    onJumpToLatest: () => { this.deferredJump = null; this.navigation.jumpToLatest(); },
    onReturnToReadingPosition: () => { this.deferredJump = null; if (!this.navigation.restoreReadingPosition()) this.notice("navigation", "The earlier reading position is no longer retained.", "info"); },
    onOpenSearch: () => { this.bookmarksOpen = false; this.deferredJump = null; this.navigation.beginSearch?.(); this.search = { phase: "idle", query: this.search.query }; this.emit(); if (this.search.query.trim()) this.scheduleSearch(); },
    onCloseSearch: () => { this.deferredJump = null; this.cancelSearch(); this.search = { phase: "closed", query: this.search.query };
      if (this.navigation.cancelSearch?.() === false) this.notice("navigation", "The earlier reading position is no longer retained.", "info"); else this.emit(); },
    onSearchQueryChange: query => { this.deferredJump = null; this.search = { phase: "idle", query }; this.emit(); this.scheduleSearch(); },
    onRetrySearch: () => this.scheduleSearch(true),
    onSoundModeChange: mode => {
      this.preferences = { ...this.preferences, soundMode: mode };
      const pending = this.sound.setMode(mode);
      this.storage.writePreferences(this.preferences, this.credential ?? undefined);
      this.emit();
      void Promise.resolve(pending).catch(() => this.emit());
    },
    onPreviewSound: () => { void Promise.resolve(this.sound.preview()).catch(() => this.emit()); },
    onShortcutChange: shortcut => { this.preferences = { ...this.preferences, textSendShortcut: shortcut }; this.storage.writePreferences(this.preferences, this.credential ?? undefined); this.emit(); },
    onShareTypingChange: enabled => { this.preferences = { ...this.preferences, shareTyping: enabled }; this.storage.writePreferences(this.preferences, this.credential ?? undefined); if (!enabled) this.setTyping(false); this.emit(); },
    onSetPin: id => this.setPin(id),
    onToggleExpanded: key => {
      this.navigation.beforeUpdate();
      if (this.expandedKeys.has(key)) this.expandedKeys.delete(key); else this.expandedKeys.add(key);
      this.emit();
    },
    onReadingSizeChange: size => {
      this.navigation.beforeUpdate(); this.preferences = { ...this.preferences, readingSize: size };
      this.storage.writePreferences(this.preferences, this.credential ?? undefined); this.emit();
    },
    onMemberSoundsChange: enabled => {
      this.preferences = { ...this.preferences, memberSounds: enabled };
      this.storage.writePreferences(this.preferences, this.credential ?? undefined); this.emit();
    },
    onToggleBookmark: id => this.toggleBookmark(id),
    onOpenBookmarks: () => {
      this.deferredJump = null; this.cancelSearch(); this.search = { phase: "closed", query: this.search.query };
      if (this.navigation.cancelSearch?.() === false) this.notice("navigation", "The earlier reading position is no longer retained.", "info");
      this.bookmarksOpen = true; this.emit();
    },
    onCloseBookmarks: () => { this.bookmarksOpen = false; this.emit(); },
    onRemoveBookmark: id => { this.bookmarks = this.bookmarks.filter(item => item.id !== id); this.persistBookmarks(); this.emit(); },
    onClearBookmarks: () => {
      if (!this.bookmarks.length) return;
      this.bookmarks = []; this.persistBookmarks(); this.emit();
    },
    onJumpToBookmark: id => {
      this.deferredJump = null;
      const bookmark = this.bookmarks.find(item => item.id === id);
      if (!bookmark || bookmark.epochId !== this.credential?.epochId || !this.room?.messages.some(message => message.id === bookmark.messageId)) {
        this.notice("bookmark", "The original message is no longer retained. The saved bookmark remains available.", "info"); return;
      }
      this.bookmarksOpen = false; this.jump(bookmark.messageId, "quote"); this.emit();
    },
    onDismissNotice: id => { this.notices = this.notices.filter(item => item.id !== id); this.emit(); },
  };

  private async joinRoom(): Promise<void> {
    if (this.join.phase === "submitting") return;
    const generation = this.lifecycle;
    this.join = { ...this.join, phase: "submitting", error: null };
    this.joinAbort?.abort();
    const abort = new AbortController(); this.joinAbort = abort;
    this.emit();
    const identityToken = this.join.useSavedIdentity !== false ? this.storage.readRestoreCredential?.() : null;
    try {
      const credential = await this.http.createSession({ displayName: this.join.displayName,
        ...(this.join.adminPassword ? { adminPassword: this.join.adminPassword } : {}),
        ...(identityToken ? { identityToken } : {}) }, abort.signal);
      if (!this.active || generation !== this.lifecycle || abort.signal.aborted || this.joinAbort !== abort) return;
      this.enter(credential);
      const recovery = this.recovery; this.recovery = null;
      if (recovery && this.confirm("Restore saved text, code and unconfirmed message content from the previous session as an unsent draft?")) {
        this.draft = { ...recovery, revision: Math.max(this.draft.revision, recovery.revision) + 1, replyTarget: null };
        this.reply = null;
        this.persist();
      }
      this.emit();
    } catch (error) {
      if (generation !== this.lifecycle || abort.signal.aborted || this.joinAbort !== abort) return;
      if (error instanceof HttpFailure && error.problem.code === "UNAUTHENTICATED" && identityToken) {
        this.storage.clearRestoreCredential?.();
        this.join = { ...this.join, restoreAvailable: false, useSavedIdentity: false, phase: "error", error: "The saved guest identity has expired. Join again to start with a fresh identity." };
      } else this.join = { ...this.join, phase: "error", error: messageText(error) };
      this.emit();
    }
  }

  private enter(credential: SessionCredential, reuseSession = false): void {
    this.credential = credential;
    this.join = { ...this.join, adminPassword: "" };
    if (credential.identityToken) this.storage.writeRestoreCredential?.(credential.identityToken);
    this.preferences = { ...defaultPreferences(), ...this.storage.readPreferences(credential) };
    this.sound.restore(this.preferences.soundMode);
    this.bookmarks = [...(this.storage.readBookmarks?.(credential) ?? [])];
    this.bookmarksOpen = false; this.pendingPin = null; this.expandedKeys.clear();
    this.memberEventIds.clear(); this.activity = [];
    this.memberEvents = [];
    this.room = null;
    this.draft = this.storage.readDraft(credential) ?? emptyDraft();
    this.reply = null;
    this.outbox = reuseSession ? [...this.storage.readOutbox(credential)] : [];
    if (!reuseSession) this.storage.writeOutbox(credential, []);
    this.receipts.clear(); this.attempts.clear(); this.reactions.clear();
    this.search = { phase: "closed", query: "" };
    this.notices = [];
    this.reconnectAttempt = 0;
    this.storage.writeSession(credential);
    this.connect();
    this.emit();
  }

  private connect(): void {
    if (!this.active || !this.credential || this.connection.phase === "ended") return;
    this.clearReconnect();
    this.connection = { phase: "connecting" };
    this.synchronizing = true;
    this.transport.connect(this.credential);
    this.emit();
  }

  private disconnected(): void {
    if (!this.active || !this.credential || this.connection.phase === "ended") return;
    this.typing = false;
    this.outbox = this.outbox.map(entry => entry.delivery.phase === "sending" && !this.receipts.has(entry.operationId)
      ? { ...entry, delivery: { phase: "unknown", canRetry: true, reason: "disconnected" } } : entry);
    this.reactions.clear();
    this.persist();
    this.clearReconnect();
    if (typeof navigator !== "undefined" && navigator.onLine === false) { this.connection = { phase: "offline", canRetry: true }; this.emit(); return; }
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > LIMITS.reconnectMaxAttempts) { this.connection = { phase: "offline", canRetry: true }; this.emit(); return; }
    const delay = Math.min(LIMITS.reconnectBaseMs * 2 ** (this.reconnectAttempt - 1), LIMITS.reconnectCapMs);
    this.connection = { phase: "reconnecting", attempt: this.reconnectAttempt, nextAttemptAt: this.now() + delay };
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.emit();
  }

  private readonly blur = (): void => { this.focused = false; this.setTyping(false); };
  private readonly focus = (): void => { this.focused = this.textarea !== null && document.activeElement === this.textarea; };
  private readonly visibility = (): void => { if (document.visibilityState === "hidden") this.blur(); else this.focus(); };
  private captureTypingDeadlines(entries: readonly { userId: string; expiresAt: number }[], serverTime: number): void {
    this.typingDeadlines.clear();
    const receivedAt = this.monotonic();
    for (const entry of entries) this.typingDeadlines.set(entry.userId, receivedAt + Math.max(0, Math.min(LIMITS.typingTtlMs, entry.expiresAt - serverTime)));
  }

  private readonly online = (): void => { if (this.credential && this.connection.phase !== "ended") { this.reconnectAttempt = 0; this.connect(); } };
  private readonly offline = (): void => { if (this.credential && this.connection.phase !== "ended") { this.transport.disconnect(); this.disconnected(); } };
  private clearReconnect(): void { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

  private send(type: "message.send", payload: Extract<ClientEvent, { type: "message.send" }>["payload"]): boolean;
  private send(type: "reaction.set", payload: Extract<ClientEvent, { type: "reaction.set" }>["payload"]): boolean;
  private send(type: "pin.set", payload: Extract<ClientEvent, { type: "pin.set" }>["payload"]): boolean;
  private send(type: "room.sync", payload: { roomId: "lobby" }): boolean;
  private send(type: "typing.set", payload: { roomId: "lobby"; active: boolean }): boolean;
  private send(type: "message.send" | "reaction.set" | "pin.set" | "room.sync" | "typing.set", payload: unknown): boolean {
    if (!this.credential) return false;
    return this.transport.send({ v: 1, type, epochId: this.credential.epochId, requestId: crypto.randomUUID(), payload } as ClientEvent);
  }

  receive(event: ServerEvent): void {
    if (!this.active || !this.credential || this.connection.phase === "ended") return;
    if (event.epochId !== this.credential.epochId) { this.end("server-restarted"); return; }
    switch (event.type) {
      case "session.ready":
        if (event.payload.self.id !== this.credential.self.id || event.payload.snapshot.epochId !== this.credential.epochId) { this.end("server-restarted"); return; }
        this.credential = { ...this.credential, self: event.payload.self, expiresAt: event.payload.expiresAt,
          ...(event.payload.role ? { role: event.payload.role } : {}) };
        this.storage.writeSession(this.credential);
        this.acceptSnapshot(event.payload.snapshot, event.serverTime); break;
      case "room.snapshot": this.acceptSnapshot(event.payload.snapshot, event.serverTime); break;
      case "room.delta": {
        if (!this.room || this.synchronizing) return;
        const result = applyRoomDelta(this.room, event.payload);
        if (result.kind === "duplicate") return;
        if (result.kind === "gap") { this.synchronize(); return; }
        this.navigation.beforeUpdate();
        const change = event.payload.change;
        const incoming = change.kind === "message.created" && change.message.author.id !== this.credential.self.id;
        this.room = result.snapshot;
        if (change.kind === "pin.changed" && this.pendingPin?.messageId === (change.pin?.message.id ?? null)) this.pendingPin = null;
        this.pruneExpanded();
        this.reconcile();
        if (this.search.phase === "results") this.search = { ...this.search, mayBeStale: true };
        if (incoming && change.kind === "message.created") { this.incomingIds.add(change.message.id); if (!this.isForeground()) this.sound.receive(); }
        this.refreshReply(); this.persist(); this.emit(); break;
      }
      case "member.event": {
        const member = event.payload;
        if (this.memberEventIds.has(member.id)) return;
        this.memberEventIds.add(member.id);
        while (this.memberEventIds.size > 256) this.memberEventIds.delete(this.memberEventIds.values().next().value!);
        this.memberEvents = [...this.memberEvents, member].slice(-200);
        if (member.user.id === this.credential.self.id || this.connection.phase !== "ready" || this.synchronizing || !this.room) return;
        this.activity = [...this.activity, { id: member.id, displayName: member.user.displayName, kind: member.kind, expiresAt: this.monotonic() + 8_000 }].slice(-4);
        if (this.preferences.soundMode === "incoming" && this.preferences.memberSounds !== false) this.sound.receive(member.kind);
        this.emit(); break;
      }
      case "pin.accepted":
        if (this.pendingPin?.operationId === event.payload.operationId) this.pendingPin = null;
        if (this.room && event.payload.appliedRevision > this.room.revision) this.synchronize();
        this.emit(); break;
      case "message.accepted": this.acceptReceipt(event.payload); break;
      case "reaction.accepted": {
        for (const [key, pending] of this.reactions) if (pending.operationId === event.payload.operationId) this.reactions.delete(key);
        if (this.room && event.payload.appliedRevision > this.room.revision) this.synchronize();
        this.emit(); break;
      }
      case "presence.state":
        if (this.room && event.payload.version > this.room.presence.version) { this.room = { ...this.room, presence: event.payload }; this.emit(); }
        break;
      case "typing.state":
        if (this.room && event.payload.version > this.room.typing.version) { this.room = { ...this.room, typing: event.payload }; this.captureTypingDeadlines(event.payload.entries, event.serverTime); this.emit(); }
        break;
      case "request.error": {
        const { error, operationId } = event.payload;
        if (error.code === "SESSION_EXPIRED") { this.end("expired"); return; }
        if (error.code === "SESSION_REPLACED") { this.end("replaced"); return; }
        if (error.code === "EPOCH_MISMATCH") { this.end("server-restarted"); return; }
        if (error.code === "UNAUTHENTICATED") { this.end("expired"); return; }
        if (operationId && (this.receipts.has(operationId)
          || this.room?.messages.some(message => message.author.id === this.credential?.self.id && message.clientOperationId === operationId))) return;
        if (operationId && !this.outbox.some(entry => entry.operationId === operationId)
          && ![...this.reactions.values()].some(pending => pending.operationId === operationId)
          && this.pendingPin?.operationId !== operationId) return;
        if (operationId) {
          if (this.pendingPin?.operationId === operationId) this.pendingPin = null;
          this.outbox = this.outbox.map(entry => entry.operationId !== operationId ? entry : { ...entry,
            delivery: error.outcome === "unknown" ? { phase: "unknown", canRetry: true, reason: "server-error" } : { phase: "rejected", error } });
          this.attempts.delete(operationId);
          for (const [key, pending] of this.reactions) if (pending.operationId === operationId) this.reactions.delete(key);
        }
        this.persist(); this.notice("request", error.message, "warning"); break;
      }
      case "session.ended": this.end(event.payload.reason); break;
    }
  }

  private acceptSnapshot(snapshot: RoomSnapshot, serverTime: number): void {
    if (!this.credential || snapshot.epochId !== this.credential.epochId) { this.end("server-restarted"); return; }
    if (snapshotInvariantErrors(snapshot).length) { this.notice("snapshot", "The room snapshot was inconsistent. Retrying synchronization.", "warning"); this.synchronizing = false; this.synchronize(); return; }
    if (this.room && snapshot.revision < this.room.revision) { this.synchronizing = false; this.synchronize(); return; }
    this.navigation.beforeUpdate();
    this.room = snapshot;
    this.memberEvents = [...(snapshot.memberEvents ?? [])].slice(-200);
    this.memberEventIds.clear();
    for (const member of this.memberEvents) this.memberEventIds.add(member.id);
    if (this.pendingPin?.messageId === (snapshot.pin?.message.id ?? null)) this.pendingPin = null;
    this.pruneExpanded();
    this.captureTypingDeadlines(snapshot.typing.entries, serverTime);
    for (const [operationId, receipt] of this.receipts) {
      if (receipt.retained && !snapshot.messages.some(message => message.id === receipt.messageId)
        && receipt.sequence <= (snapshot.history.newestSequence ?? 0)) {
        this.receipts.set(operationId, { ...receipt, retained: false });
        this.outbox = this.outbox.map(entry => entry.operationId === operationId ? { ...entry, delivery: { phase: "accepted-outside-history" } } : entry);
      }
    }
    const retainedIds = new Set(snapshot.messages.map(message => message.id));
    for (const id of this.incomingIds) if (!retainedIds.has(id)) this.incomingIds.delete(id);
    this.reconcile();
    this.synchronizing = false;
    this.connection = { phase: "ready" };
    this.reconnectAttempt = 0;
    this.refreshReply(true);
    this.persist(); this.emit();
  }

  private synchronize(): void {
    if (this.synchronizing || !this.credential || this.connection.phase === "ended") return;
    this.synchronizing = true;
    this.connection = { phase: "synchronizing" };
    if (!this.send("room.sync", { roomId: "lobby" })) { this.synchronizing = false; this.disconnected(); }
    this.emit();
  }

  private reconcile(): void {
    if (!this.room) return;
    const remaining = reconcileOutbox(this.outbox, this.room.messages);
    const keys = new Set(remaining.map(entry => entry.operationId));
    for (const entry of this.outbox) if (!keys.has(entry.operationId)) { this.attempts.delete(entry.operationId); this.receipts.delete(entry.operationId); }
    this.outbox = remaining;
  }

  private acceptReceipt(receipt: MessageReceipt): void {
    if (!this.outbox.some(entry => entry.operationId === receipt.operationId)) return;
    this.attempts.delete(receipt.operationId);
    this.receipts.set(receipt.operationId, receipt);
    if (!receipt.retained) this.outbox = this.outbox.map(entry => entry.operationId === receipt.operationId ? { ...entry, delivery: { phase: "accepted-outside-history" } } : entry);
    this.reconcile();
    this.persist(); this.emit();
    if (receipt.retained && this.room && !this.room.messages.some(message => message.id === receipt.messageId)) this.synchronize();
  }

  private changeDraft(intent: DraftIntent): void {
    this.draft = advanceDraft(this.draft, intent);
    if (intent.type === "reply.cleared") this.reply = null;
    this.composerError = null;
    this.lastEdit = this.monotonic();
    const body = this.draft.mode === "text" ? this.draft.textBuffer : this.draft.codeBuffer.source;
    this.setTyping(this.focused && this.preferences.shareTyping && body.trim().length > 0);
    this.persist(); this.emit();
  }

  submit(intent: SubmitIntent): void {
    if (!this.active || !this.credential || intent.draftRevision !== this.draft.revision || this.composing
      || composerDisabledReason(this.draft, this.connection, this.pendingCount()) !== null) return;
    const operationId = crypto.randomUUID();
    const input = { operationId, roomId: "lobby" as const,
      content: this.draft.mode === "text" ? { kind: "text" as const, text: this.draft.textBuffer }
        : { kind: "code" as const, source: this.draft.codeBuffer.source, language: this.draft.codeBuffer.language },
      replyToId: this.draft.replyTarget?.epochId === this.credential.epochId ? this.draft.replyTarget.messageId : null };
    this.navigation.beforeUpdate();
    for (const entry of this.outbox) if (entry.delivery.phase === "accepted-outside-history") {
      this.receipts.delete(entry.operationId); this.attempts.delete(entry.operationId);
    }
    this.outbox = [...this.outbox.filter(entry => entry.delivery.phase !== "accepted-outside-history"), { operationId, epochId: this.credential.epochId, ownerUserId: this.credential.self.id, localCreatedAt: this.now(), input, delivery: { phase: "sending" } }];
    this.draft = { ...this.draft, revision: this.draft.revision + 1, replyTarget: null,
      ...(this.draft.mode === "text" ? { textBuffer: "" } : { codeBuffer: { ...this.draft.codeBuffer, source: "" } }) };
    this.reply = null; this.composerError = null;
    this.setTyping(false);
    this.attempts.set(operationId, this.monotonic());
    this.persist();
    if (!this.send("message.send", input)) this.outbox = this.outbox.map(entry => entry.operationId === operationId ? { ...entry, delivery: { phase: "unknown", canRetry: true, reason: "disconnected" } } : entry);
    if (this.navigation.state().navigationMode === "following") this.navigation.jumpToLatest();
    this.persist(); this.emit();
  }

  private retry(operationId: string): void {
    const entry = this.outbox.find(item => item.operationId === operationId);
    if (!entry || entry.delivery.phase !== "unknown" || this.connection.phase !== "ready" || entry.epochId !== this.credential?.epochId) return;
    this.outbox = this.outbox.map(item => item === entry ? { ...item, delivery: { phase: "sending" } } : item);
    this.attempts.set(operationId, this.monotonic());
    if (!this.send("message.send", entry.input)) this.outbox = this.outbox.map(item => item.operationId === operationId ? { ...item, delivery: { phase: "unknown", canRetry: true, reason: "disconnected" } } : item);
    this.persist(); this.emit();
  }

  private restore(operationId: string): void {
    const entry = this.outbox.find(item => item.operationId === operationId);
    if (!entry || entry.delivery.phase === "sending") return;
    const hasContent = this.draft.textBuffer.trim() || this.draft.codeBuffer.source.trim();
    if (hasContent && !this.confirm("Replace the current draft with this message?")) return;
    const content = entry.input.content;
    const target = this.room?.messages.find(message => message.id === entry.input.replyToId);
    this.draft = { ...this.draft, revision: this.draft.revision + 1, mode: content.kind,
      ...(content.kind === "text" ? { textBuffer: content.text } : { codeBuffer: { source: content.source, language: content.language } }),
      replyTarget: target && this.credential ? { epochId: this.credential.epochId, messageId: target.id } : null };
    this.reply = target ? this.quote(target) : null;
    this.outbox = this.outbox.filter(item => item.operationId !== operationId);
    this.receipts.delete(operationId); this.attempts.delete(operationId);
    this.persist(); this.emit(); this.textarea?.focus({ preventScroll: true });
  }

  private selectReply(messageId: string): void {
    const message = this.room?.messages.find(item => item.id === messageId);
    if (!message || !this.credential) { this.notice("reply", "This message is no longer retained.", "info"); return; }
    this.draft = { ...this.draft, revision: this.draft.revision + 1, replyTarget: { epochId: this.credential.epochId, messageId } };
    this.reply = this.quote(message);
    this.persist(); this.emit(); this.textarea?.focus({ preventScroll: true });
  }

  private quote(message: ChatMessage): QuoteView {
    return { messageId: message.id, author: message.author, kind: message.content.kind, previewText: [...rawContent(message.content)].slice(0, LIMITS.quotePreviewCodePoints).join(""), availability: "available" };
  }
  private refreshReply(fromSnapshot = false): void {
    if (!this.draft.replyTarget) { this.reply = null; return; }
    const target = this.room?.messages.find(message => message.id === this.draft.replyTarget?.messageId);
    if (target) this.reply = this.quote(target);
    else if (this.reply) this.reply = { ...this.reply, availability: "expired" };
    else if (fromSnapshot) {
      this.draft = { ...this.draft, revision: this.draft.revision + 1, replyTarget: null };
      this.notices = [...this.notices.filter(item => item.id !== "reply"), { id: "reply", severity: "info", message: "The saved reply target is no longer retained. The draft text has been preserved.", dismissible: true }];
    }
  }

  private setReaction(messageId: string, emoji: typeof REACTION_EMOJIS[number], active: boolean): void {
    const key = `${messageId}:${emoji}`;
    if (this.connection.phase !== "ready" || !this.room?.messages.some(message => message.id === messageId) || this.reactions.has(key)) return;
    const operationId = crypto.randomUUID();
    if (!this.send("reaction.set", { operationId, roomId: "lobby", messageId, emoji, active })) return;
    this.reactions.set(key, { operationId, messageId, emoji, sentAt: this.monotonic() }); this.emit();
  }

  private setTyping(active: boolean): void {
    const allowed = active && this.preferences.shareTyping && this.connection.phase === "ready";
    if (allowed === this.typing && (!allowed || this.monotonic() - this.lastTypingSent < LIMITS.typingRenewMs)) return;
    if (this.connection.phase === "ready") this.send("typing.set", { roomId: "lobby", active: allowed });
    this.typing = allowed; this.lastTypingSent = this.monotonic();
  }

  private tick(): void {
    if (!this.active) return;
    if (this.credential && this.credential.expiresAt <= this.now() && this.connection.phase !== "ended") { this.end("expired"); return; }
    if (this.typing) this.setTyping(this.focused && this.monotonic() - this.lastEdit < LIMITS.typingIdleMs);
    let changed = false;
    const activeActivity = this.activity.filter(item => item.expiresAt > this.monotonic());
    if (activeActivity.length !== this.activity.length) { this.activity = activeActivity; changed = true; }
    if (this.pendingPin && this.monotonic() - this.pendingPin.sentAt >= LIMITS.ackTimeoutMs) {
      this.pendingPin = null; changed = true; this.synchronize();
      this.notice("pin", "The pin result is not confirmed. The public pin is being synchronized.", "info");
    }
    this.outbox = this.outbox.map(entry => {
      const sentAt = this.attempts.get(entry.operationId);
      if (entry.delivery.phase !== "sending" || this.receipts.has(entry.operationId) || sentAt === undefined || this.monotonic() - sentAt < LIMITS.ackTimeoutMs) return entry;
      this.attempts.delete(entry.operationId); changed = true;
      return { ...entry, delivery: { phase: "unknown", canRetry: true, reason: "timeout" } };
    });
    for (const [key, pending] of this.reactions) if (this.monotonic() - pending.sentAt >= LIMITS.ackTimeoutMs) { this.reactions.delete(key); changed = true; this.synchronize(); }
    if (this.room?.typing.entries.some(entry => (this.typingDeadlines.get(entry.userId) ?? 0) <= this.monotonic())) {
      this.room = { ...this.room, typing: { ...this.room.typing, entries: this.room.typing.entries.filter(entry => (this.typingDeadlines.get(entry.userId) ?? 0) > this.monotonic()) } };
      for (const [id, deadline] of this.typingDeadlines) if (deadline <= this.monotonic()) this.typingDeadlines.delete(id);
      changed = true;
    }
    if (changed) { this.persist(); this.emit(); }
  }

  private cancelSearch(): void {
    this.searchGeneration += 1;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null; this.searchAbort?.abort(); this.searchAbort = null;
  }
  private scheduleSearch(immediate = false): void {
    this.cancelSearch();
    if (this.search.phase === "closed" || !this.credential) return;
    const query = this.search.query.trim();
    if (!query) { this.search = { phase: "idle", query: this.search.query }; this.emit(); return; }
    if ([...query].length > LIMITS.searchQueryCodePoints) { this.search = { phase: "error", query: this.search.query, message: `Search supports up to ${LIMITS.searchQueryCodePoints} characters.`, retryable: false }; this.emit(); return; }
    const generation = this.searchGeneration;
    this.search = { phase: "loading", query: this.search.query }; this.emit();
    this.searchTimer = setTimeout(() => { this.searchTimer = null; void this.runSearch(query, generation); }, immediate ? 0 : LIMITS.searchDebounceMs);
  }
  private async runSearch(query: string, generation: number): Promise<void> {
    const credential = this.credential;
    if (!credential || generation !== this.searchGeneration) return;
    const abort = new AbortController(); this.searchAbort = abort;
    try {
      const response = await this.http.search(credential, { query, limit: LIMITS.searchResults }, abort.signal);
      if (!this.active || abort.signal.aborted || generation !== this.searchGeneration || this.credential !== credential || this.search.phase === "closed") return;
      if (response.epochId !== credential.epochId) { this.end("server-restarted"); return; }
      if (response.query !== query) throw new Error("The server returned results for another query.");
      this.search = response.totalMatches === 0 ? { phase: "empty", query: this.search.query, response }
        : { phase: "results", query: this.search.query, response, mayBeStale: response.asOfRevision !== this.room?.revision };
      this.emit();
    } catch (error) {
      if (abort.signal.aborted || generation !== this.searchGeneration || this.search.phase === "closed" || this.credential !== credential) return;
      if (error instanceof HttpFailure && (error.problem.code === "UNAUTHENTICATED" || error.problem.code === "SESSION_EXPIRED")) { this.end("expired"); return; }
      this.search = { phase: "error", query: this.search.query, message: messageText(error), retryable: true }; this.emit();
    }
  }

  private end(reason: Extract<ConnectionView, { phase: "ended" }>["reason"]): void {
    this.setTyping(false); this.clearReconnect(); this.cancelSearch(); this.transport.disconnect();
    this.connection = { phase: "ended", reason }; this.synchronizing = false; this.reactions.clear(); this.pendingPin = null; this.activity = [];
    this.outbox = this.outbox.map(entry => entry.delivery.phase === "sending" ? { ...entry, delivery: { phase: "unknown", canRetry: false, reason: "session-lost" } } : entry);
    this.persist(); this.emit();
  }
  private returnToJoin(): void {
    this.recovery = null;
    const name = this.credential?.self.displayName ?? this.join.displayName;
    const unsent = this.outbox.filter(entry => entry.delivery.phase !== "accepted-outside-history" && !this.receipts.has(entry.operationId));
    if (this.draft.textBuffer.trim() || this.draft.codeBuffer.source.trim() || unsent.length) {
      if (!this.draft.textBuffer.trim() && !this.draft.codeBuffer.source.trim() && unsent.length === 1) {
        const content = unsent[0]!.input.content;
        this.recovery = { ...emptyDraft(), revision: this.draft.revision, mode: content.kind,
          ...(content.kind === "text" ? { textBuffer: content.text } : { codeBuffer: { source: content.source, language: content.language } }) };
      } else {
        const recovered = unsent.map(entry => rawContent(entry.input.content)).join("\n\n");
        this.recovery = { ...this.draft, ...(recovered ? { mode: "text", textBuffer: [this.draft.textBuffer, recovered].filter(Boolean).join("\n\n") } : {}) };
      }
    }
    this.clearReconnect(); this.cancelSearch(); this.transport.disconnect(); this.storage.clearSession();
    this.credential = null; this.room = null; this.outbox = []; this.receipts.clear(); this.attempts.clear(); this.reactions.clear();
    this.connection = { phase: "connecting" }; this.join = { displayName: name, adminPassword: "", restoreAvailable: !!this.storage.readRestoreCredential?.(), useSavedIdentity: true, phase: "idle", error: null }; this.draft = emptyDraft(); this.reply = null; this.notices = [];
    this.composing = false; this.focused = false; this.typing = false; this.typingDeadlines.clear(); this.incomingIds.clear(); this.deferredJump = null;
    this.pendingPin = null; this.activity = []; this.memberEvents = []; this.memberEventIds.clear(); this.bookmarks = []; this.bookmarksOpen = false; this.expandedKeys.clear();
    this.navigation.jumpToLatest(); this.emit();
  }
  private async leave(): Promise<void> {
    const credential = this.credential;
    this.persist(); this.setTyping(false);
    if (credential) this.storage.writeOutbox(credential, []);
    this.returnToJoin();
    if (credential) { try { await this.http.revokeSession(credential); } catch { /* Connection closure removes live presence. */ } }
  }
  private readonly persist = (): void => {
    if (!this.credential) return;
    this.storage.writeDraft(this.credential, this.draft);
    this.storage.writeOutbox(this.credential, this.outbox);
  };
  private notice(id: string, message: string, severity: NoticeView["severity"]): void {
    this.notices = [...this.notices.filter(item => item.id !== id), { id, message, severity, dismissible: true }].slice(-5); this.emit();
  }
  private emit(): void {
    this.projection = this.project();
    for (const listener of this.listeners) listener();
  }

  private jump(id: string, reason: "search" | "quote"): void {
    const target = this.room?.messages.find(message => message.id === id);
    if (target && this.collapsible(target) && !this.expandedKeys.has(messageRenderKey(target))) {
      this.navigation.beforeUpdate(); this.expandedKeys.add(messageRenderKey(target));
      this.deferredJump = { id, reason }; this.emit(); return;
    }
    if (!this.navigation.jumpToMessage(id, reason)) this.notice("navigation", "This message is no longer retained.", "info");
    else if (reason === "search") { this.search = { phase: "closed", query: this.search.query }; this.cancelSearch(); this.emit(); }
  }

  private collapsible(message: Pick<ChatMessage, "content">): boolean {
    const body = rawContent(message.content);
    return [...body].length > 1200 || body.split("\n").length > 12;
  }

  private pruneExpanded(): void {
    const retained = new Set((this.room?.messages ?? []).map(messageRenderKey));
    for (const entry of this.outbox) retained.add(`message:${entry.ownerUserId}:${entry.operationId}`);
    for (const key of this.expandedKeys) if (!retained.has(key)) this.expandedKeys.delete(key);
  }

  private setPin(messageId: string | null): void {
    if (!this.credential || this.credential.role !== "admin" || this.connection.phase !== "ready" || this.pendingPin) return;
    if (messageId !== null && !this.room?.messages.some(message => message.id === messageId)) {
      this.notice("pin", "This message is no longer retained.", "info"); return;
    }
    const operationId = crypto.randomUUID();
    this.pendingPin = { operationId, messageId, sentAt: this.monotonic() };
    if (!this.send("pin.set", { operationId, roomId: "lobby", messageId })) {
      this.pendingPin = null;
      this.notice("pin", "The pin could not be sent while disconnected.", "info"); return;
    }
    this.emit();
  }

  private toggleBookmark(messageId: string): void {
    if (!this.credential) return;
    const epochId = this.credential.epochId;
    const existing = this.bookmarks.find(bookmark => bookmark.epochId === epochId && bookmark.messageId === messageId);
    if (existing) this.bookmarks = this.bookmarks.filter(bookmark => bookmark.id !== existing.id);
    else {
      const message = this.room?.messages.find(item => item.id === messageId);
      if (!message) { this.notice("bookmark", "This message is no longer retained.", "info"); return; }
      const bookmark: StoredBookmark = { id: crypto.randomUUID(), epochId, messageId,
        author: { ...message.author }, createdAt: message.createdAt, savedAt: this.now(), content: { ...message.content } };
      const candidates = [bookmark, ...this.bookmarks];
      if (candidates.length > 100 || utf8Bytes(JSON.stringify(candidates)) > 1024 * 1024) {
        this.notice("bookmark", "The bookmark limit has been reached. Remove saved bookmarks before adding more.", "info"); return;
      }
      this.bookmarks = candidates;
    }
    this.persistBookmarks(); this.emit();
  }

  private persistBookmarks(): void {
    if (this.credential && this.storage.writeBookmarks?.(this.credential, this.bookmarks) === false)
      this.notice("bookmark-storage", "Bookmarks are available for this visit. Browser storage could not save them.", "warning");
  }

  private pinMessage(items: readonly TimelineItem[], retained: ReadonlySet<string>): MessageView | null {
    const pin = this.room?.pin;
    if (!pin || !this.credential) return null;
    const message = pin.message;
    const available = retained.has(message.id);
    const matching = items.find(item => item.type === "message" && item.message.identity.kind === "canonical" && item.message.identity.messageId === message.id);
    if (matching?.type === "message") return matching.message;
    return {
      key: messageRenderKey(message), identity: { kind: "canonical", messageId: message.id, sequence: message.sequence },
      author: message.author, isMine: message.author.id === this.credential.self.id, createdAt: message.createdAt, content: message.content,
      delivery: { phase: message.author.id === this.credential.self.id ? "confirmed" : "incoming" }, quote: null, reactions: [], grouping: "start",
      actions: { canReply: available && this.connection.phase !== "ended", canReact: false, canRestoreToComposer: false, canPin: false },
      fold: { collapsible: this.collapsible(message), expanded: this.expandedKeys.has(messageRenderKey(message)) },
      bookmarked: this.bookmarks.some(bookmark => bookmark.epochId === message.epochId && bookmark.messageId === message.id),
      highlighted: false, searchMatches: [],
    };
  }

  private pendingCount(): number { return this.outbox.filter(entry => entry.delivery.phase !== "accepted-outside-history").length; }

  private project(): AppView {
    const credential = this.credential;
    if (!credential) return { screen: "join", join: this.join };
    const messages = this.room?.messages ?? [];
    const retained = new Set(messages.map(message => message.id));
    const nav = this.navigation.state();
    const matches = this.search.phase === "results" ? this.search.response.results : [];
    const items: TimelineItem[] = [];
    if ((this.room?.history.oldestSequence ?? 1) > 1) items.push({ type: "history-boundary", key: "history-boundary", label: "Earlier messages are no longer retained" });
    let previous: ChatMessage | null = null;
    let previousDay = "";
    const timelineEntries = [
      ...messages.map(message => ({ at: message.createdAt, message, event: null as MemberEvent | null })),
      ...this.memberEvents.map(event => ({ at: event.occurredAt, message: null as ChatMessage | null, event })),
    ].sort((left, right) => left.at - right.at);
    for (const entry of timelineEntries) {
      if (entry.event) {
        const event = entry.event;
        const day = dayLabel(event.occurredAt);
        if (day !== previousDay) { items.push({ type: "date-separator", key: `date:${day}`, label: day }); previousDay = day; previous = null; }
        const eventMessage: MessageView = {
          key: `member:${event.id}`, identity: { kind: "canonical", messageId: event.id, sequence: 0 },
          author: event.user, isMine: event.user.id === credential.self.id, createdAt: event.occurredAt,
          content: { kind: "text", text: `${event.user.displayName} ${event.kind === "joined" ? "joined the room." : event.kind === "left" ? "left the room." : event.displayNameChanged ? "returned under a new display name." : "returned to the room."}` },
          systemEvent: event.kind, delivery: { phase: "incoming" }, quote: null, reactions: [], grouping: "start",
          actions: { canReply: false, canReact: false, canRestoreToComposer: false, canPin: false },
          fold: { collapsible: false, expanded: true }, bookmarked: false, highlighted: false, searchMatches: [],
        };
        items.push({ type: "message", key: eventMessage.key, message: eventMessage });
        previous = null;
        continue;
      }
      const message = entry.message!;
      const day = dayLabel(message.createdAt);
      if (day !== previousDay) { items.push({ type: "date-separator", key: `date:${day}`, label: day }); previousDay = day; previous = null; }
      const grouping = previous && previous.author.id === message.author.id && previous.content.kind === "text" && message.content.kind === "text"
        && !previous.reply && !message.reply && message.createdAt - previous.createdAt <= LIMITS.groupWindowMs ? "continuation" : "start";
      const view: MessageView = {
        key: messageRenderKey(message), identity: { kind: "canonical", messageId: message.id, sequence: message.sequence },
        author: message.author, isMine: message.author.id === credential.self.id, createdAt: message.createdAt, content: message.content,
        delivery: { phase: message.author.id === credential.self.id ? "confirmed" : "incoming" },
        quote: message.reply ? { ...message.reply, availability: retained.has(message.reply.messageId) ? "available" : "expired" } : null,
        reactions: REACTION_EMOJIS.map(emoji => { const users = message.reactions.find(item => item.emoji === emoji)?.userIds ?? []; return { emoji, count: users.length, reactedByMe: users.includes(credential.self.id), pending: this.reactions.has(`${message.id}:${emoji}`), enabled: this.connection.phase === "ready" }; }),
        grouping, actions: { canReply: this.connection.phase !== "ended", canReact: this.connection.phase === "ready", canRestoreToComposer: false, canPin: credential.role === "admin" && this.connection.phase === "ready" && !this.pendingPin },
        fold: { collapsible: this.collapsible(message), expanded: this.expandedKeys.has(messageRenderKey(message)) },
        bookmarked: this.bookmarks.some(bookmark => bookmark.epochId === credential.epochId && bookmark.messageId === message.id),
        highlighted: message.id === nav.highlightedMessageId,
        searchMatches: matches.some(hit => hit.messageId === message.id) ? this.contentMatches(rawContent(message.content), this.search.query.trim()) : [],
      };
      items.push({ type: "message", key: view.key, message: view }); previous = message;
    }
    for (const entry of this.outbox) {
      const receipt = this.receipts.get(entry.operationId);
      const message: MessageView = {
        key: messageRenderKey({ author: credential.self, clientOperationId: entry.operationId }), identity: { kind: "outbox", operationId: entry.operationId },
        author: credential.self, isMine: true, createdAt: entry.localCreatedAt, content: entry.input.content,
        delivery: receipt?.retained ? { phase: "confirmed" } : entry.delivery,
        quote: null, reactions: [], grouping: "start",
        actions: { canReply: false, canReact: false, canRestoreToComposer: !receipt && entry.delivery.phase !== "sending", canPin: false },
        fold: { collapsible: this.collapsible({ content: entry.input.content }), expanded: this.expandedKeys.has(messageRenderKey({ author: credential.self, clientOperationId: entry.operationId })) }, highlighted: false, searchMatches: [],
      };
      items.push({ type: "message", key: message.key, message });
    }
    const disabledReason = composerDisabledReason(this.draft, this.connection, this.pendingCount());
    const draftStorage = this.storage.available() ? "available" : "unavailable";
    const view: ChatView = {
      self: credential.self, role: credential.role ?? "guest", room: { id: "lobby", title: "CodeRoom · Engineering Lobby", epochId: credential.epochId }, connection: this.connection,
      history: this.room?.history ?? emptyHistory(), members: this.room?.presence.members ?? [],
      typing: { users: (this.room?.presence.members ?? []).filter(user => user.id !== credential.self.id && this.room?.typing.entries.some(entry => entry.userId === user.id && (this.typingDeadlines.get(entry.userId) ?? 0) > this.monotonic())) },
      timeline: { ...nav, items },
      composer: { draft: this.draft, replyPreview: this.reply, canSubmit: disabledReason === null && !this.composing, disabledReason,
        bodyUtf8Bytes: utf8Bytes(this.draft.mode === "text" ? this.draft.textBuffer : this.draft.codeBuffer.source), bodyLimitUtf8Bytes: LIMITS.messageBodyUtf8Bytes,
        isComposing: this.composing, draftStorage, shortcut: this.preferences.textSendShortcut, error: this.composerError },
      pinned: { message: this.pinMessage(items, retained), canManage: credential.role === "admin" && this.connection.phase === "ready", pending: this.pendingPin !== null, sourceAvailable: !!this.room?.pin && retained.has(this.room.pin.message.id) },
      bookmarks: { open: this.bookmarksOpen, items: this.bookmarks.map(bookmark => ({ id: bookmark.id, author: bookmark.author, content: bookmark.content, createdAt: bookmark.createdAt, savedAt: bookmark.savedAt, sourceAvailable: bookmark.epochId === credential.epochId && retained.has(bookmark.messageId) })) },
      activity: this.activity.map(({ id, displayName, kind }) => ({ id, displayName, kind })),
      search: this.search, preferences: this.preferences, sound: this.sound.view(), notices: this.notices,
    };
    return { screen: "chat", chat: view };
  }

  private contentMatches(text: string, query: string): { start: number; end: number }[] {
    if (!query) return [];
    const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    return [...text.matchAll(expression)].slice(0, 100).map(match => ({ start: match.index, end: match.index + match[0].length }));
  }
}

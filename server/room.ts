import { createHash, randomUUID } from "node:crypto";
import type {
  ChatMessage, HistoryWindow, MessageReceipt, PresenceState, PublicUser,
  ReactionMembership, ReactionReceipt, RoomChange, RoomDelta, RoomSnapshot,
  SendMessageInput, SetReactionInput, TypingState, PublicPin, SetPinInput, PinReceipt,
  MemberEvent,
} from "../shared/domain.js";
import { rawContent } from "../shared/domain.js";
import type { ErrorCode, Problem } from "../shared/errors.js";
import type { HighlightRange, SearchHit, SearchResponse } from "../shared/http.js";
import { CODE_LANGUAGES, LIMITS, REACTION_EMOJIS } from "../shared/limits.js";
import { parseServerEvent, utf8Bytes } from "../shared/validation.js";
import { snapshotInvariantErrors } from "../shared/invariants.js";

type Operation =
  | { readonly kind: "message"; readonly fingerprint: string; readonly receipt: MessageReceipt }
  | { readonly kind: "reaction"; readonly fingerprint: string; readonly receipt: ReactionReceipt }
  | { readonly kind: "pin"; readonly fingerprint: string; readonly receipt: PinReceipt };

export interface RoomState {
  readonly epochId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly messages: readonly ChatMessage[];
  readonly pin: PublicPin | null;
  readonly memberEvents?: readonly MemberEvent[];
  readonly operations: readonly (readonly [string, readonly (readonly [string, Operation])[]])[];
}

export class RoomError extends Error {
  readonly problem: Problem;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "RoomError";
    this.problem = { code, message, retryable, outcome: "not-applied" };
  }
}

export interface RoomOptions {
  readonly clock?: () => number;
  readonly epochId?: string;
  readonly state?: RoomState;
  readonly persist?: (state: RoomState) => void;
  readonly persistent?: boolean;
}

const copyUser = (user: PublicUser): PublicUser => Object.freeze({
  id: user.id, displayName: user.displayName, avatarSeed: user.avatarSeed,
});
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wireId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class Room {
  readonly epochId: string;
  private readonly clock: () => number;
  private readonly operations = new Map<string, Map<string, Operation>>();
  private retained: readonly ChatMessage[] = Object.freeze([]);
  private roomRevision = 0;
  private messageSequence = 0;
  private serializedBytes = 2;
  private publicPin: PublicPin | null = null;
  private memberEvents: readonly MemberEvent[] = Object.freeze([]);
  private readonly persist: ((state: RoomState) => void) | undefined;
  private readonly persistent: boolean;
  private operationCount = 0;

  constructor(options: RoomOptions = {}) {
    this.epochId = options.state?.epochId ?? options.epochId ?? randomUUID();
    this.clock = options.clock ?? Date.now;
    this.persist = options.persist;
    this.persistent = options.persistent ?? false;
    if (options.state) {
      const state = options.state;
      if (!Array.isArray(state.messages) || state.messages.length > LIMITS.historyMessages || !Array.isArray(state.operations) || state.operations.length > LIMITS.activeSessions) throw new Error("Stored room state exceeds capacity.");
      const users = new Set<string>();
      for (const entry of state.operations) {
        if (!Array.isArray(entry) || entry.length !== 2 || users.has(entry[0]) || !Array.isArray(entry[1]) || entry[1].length > LIMITS.acceptedOperationsPerSession) throw new Error("Stored operation ledger is invalid.");
        users.add(entry[0]);
        const operations = new Set<string>();
        for (const item of entry[1]) {
          if (!Array.isArray(item) || item.length !== 2 || operations.has(item[0])) throw new Error("Stored operation receipt is invalid.");
          operations.add(item[0]);
        }
      }
      this.restore(options.state);
      this.validateState();
    }
  }

  get revision(): number { return this.roomRevision; }
  get messages(): readonly ChatMessage[] { return this.retained; }

  hasOperation(userId: string, operationId: string): boolean {
    return this.operations.get(userId)?.has(operationId) ?? false;
  }

  forgetUser(userId: string, persist = true): void {
    const mutation = () => { this.operationCount -= this.operations.get(userId)?.size ?? 0; this.operations.delete(userId); };
    if (persist) this.transaction(mutation); else mutation();
  }

  history(): HistoryWindow {
    return {
      retainedCount: this.retained.length,
      limit: LIMITS.historyMessages,
      serializedBytes: this.serializedBytes,
      maxSerializedBytes: LIMITS.historyJsonUtf8Bytes,
      oldestSequence: this.retained[0]?.sequence ?? null,
      newestSequence: this.retained.at(-1)?.sequence ?? null,
      persistence: this.persistent ? "sqlite" : "memory-until-server-restart",
    };
  }

  snapshot(presence: PresenceState, typing: TypingState): RoomSnapshot {
    return {
      roomId: "lobby", epochId: this.epochId, revision: this.roomRevision,
      capturedAt: this.clock(), messages: this.retained, history: this.history(),
      presence: { version: presence.version, members: presence.members.map(copyUser) },
      typing: { version: typing.version, entries: typing.entries.map((entry) => ({ ...entry })) },
      pin: this.publicPin,
      memberEvents: this.memberEvents,
    };
  }

  send(user: PublicUser, input: SendMessageInput): { receipt: MessageReceipt; delta: RoomDelta | null } {
    return this.transaction(() => this.applySend(user, input));
  }

  private applySend(user: PublicUser, input: SendMessageInput): { receipt: MessageReceipt; delta: RoomDelta | null } {
    this.checkRoom(input.roomId);
    this.checkContent(input.content);
    const fingerprint = digest(["message.send", input.roomId, input.content.kind,
      rawContent(input.content), input.content.kind === "code" ? input.content.language : null, input.replyToId]);
    const previous = this.lookup(user.id, input.operationId, fingerprint);
    if (previous) {
      if (previous.kind !== "message") throw new RoomError("OPERATION_ID_CONFLICT", "This operation ID already belongs to another action.");
      return { receipt: { ...previous.receipt, duplicate: true, retained: this.contains(previous.receipt.messageId) }, delta: null };
    }
    this.checkBudget(user.id);
    const target = input.replyToId === null ? null : this.retained.find((message) => message.id === input.replyToId);
    if (input.replyToId !== null && !target) throw new RoomError("MESSAGE_NOT_FOUND", "The quoted message is no longer retained.");
    const now = this.clock();
    const revision = this.roomRevision + 1;
    const content = input.content.kind === "text"
      ? Object.freeze({ kind: "text" as const, text: input.content.text })
      : Object.freeze({ kind: "code" as const, source: input.content.source, language: input.content.language });
    const message: ChatMessage = Object.freeze({
      id: randomUUID(), roomId: "lobby", epochId: this.epochId,
      clientOperationId: input.operationId, author: copyUser(user), sequence: this.messageSequence + 1,
      createdAt: now, content,
      reply: target ? Object.freeze({ messageId: target.id, author: copyUser(target.author), kind: target.content.kind,
        previewText: Array.from(rawContent(target.content)).slice(0, LIMITS.quotePreviewCodePoints).join("") }) : null,
      reactions: Object.freeze([]), mutationRevision: revision,
    });
    const delta = this.commit([...this.retained, message], { kind: "message.created", message }, revision);
    this.messageSequence = message.sequence;
    const receipt: MessageReceipt = Object.freeze({
      operationId: input.operationId, messageId: message.id, sequence: message.sequence,
      acceptedAt: now, appliedRevision: revision, duplicate: false, retained: this.contains(message.id),
    });
    this.remember(user.id, input.operationId, { kind: "message", fingerprint, receipt });
    return { receipt, delta };
  }

  react(user: PublicUser, input: SetReactionInput): { receipt: ReactionReceipt; delta: RoomDelta | null } {
    return this.transaction(() => this.applyReaction(user, input));
  }

  private applyReaction(user: PublicUser, input: SetReactionInput): { receipt: ReactionReceipt; delta: RoomDelta | null } {
    this.checkRoom(input.roomId);
    if (!REACTION_EMOJIS.includes(input.emoji) || typeof input.active !== "boolean") throw new RoomError("BAD_REQUEST", "A supported reaction and explicit state are required.");
    const fingerprint = digest(["reaction.set", input.roomId, input.messageId, input.emoji, input.active]);
    const previous = this.lookup(user.id, input.operationId, fingerprint);
    if (previous) {
      if (previous.kind !== "reaction") throw new RoomError("OPERATION_ID_CONFLICT", "This operation ID already belongs to another action.");
      return { receipt: { ...previous.receipt, duplicate: true, retained: this.contains(previous.receipt.messageId) }, delta: null };
    }
    this.checkBudget(user.id);
    const index = this.retained.findIndex((message) => message.id === input.messageId);
    const message = this.retained[index];
    if (!message) throw new RoomError("MESSAGE_NOT_FOUND", "This message is no longer retained.");
    const existing = message.reactions.find((reaction) => reaction.emoji === input.emoji);
    const present = existing?.userIds.includes(user.id) ?? false;
    const changed = present !== input.active;
    if (changed && input.active && (existing?.userIds.length ?? 0) >= LIMITS.reactionUsersPerEmoji) {
      throw new RoomError("REACTION_LIMIT", "This reaction has reached its participant limit.");
    }
    let delta: RoomDelta | null = null;
    if (changed) {
      const memberships: ReactionMembership[] = [];
      for (const emoji of REACTION_EMOJIS) {
        const source = message.reactions.find((reaction) => reaction.emoji === emoji)?.userIds ?? [];
        const members = emoji !== input.emoji ? [...source]
          : input.active ? [...source, user.id] : source.filter((id) => id !== user.id);
        if (members.length > 0) memberships.push(Object.freeze({ emoji, userIds: Object.freeze(members) }));
      }
      const reactions: readonly ReactionMembership[] = Object.freeze(memberships);
      const revision = this.roomRevision + 1;
      const messages = [...this.retained];
      messages[index] = Object.freeze({ ...message, reactions, mutationRevision: revision });
      delta = this.commit(messages, { kind: "reaction.changed", messageId: message.id, reactions }, revision);
    }
    const receipt: ReactionReceipt = Object.freeze({
      operationId: input.operationId, messageId: message.id, emoji: input.emoji, active: input.active,
      changed, appliedRevision: this.roomRevision, duplicate: false, retained: this.contains(message.id),
    });
    this.remember(user.id, input.operationId, { kind: "reaction", fingerprint, receipt });
    return { receipt, delta };
  }

  pin(user: PublicUser, input: SetPinInput, isAdmin: boolean): { receipt: PinReceipt; delta: RoomDelta | null } {
    if (!isAdmin) throw new RoomError("FORBIDDEN", "Administrator access is required to change the public pin.");
    return this.transaction(() => {
      this.checkRoom(input.roomId);
      const fingerprint = digest(["pin.set", input.roomId, input.messageId]);
      const previous = this.lookup(user.id, input.operationId, fingerprint);
      if (previous) {
        if (previous.kind !== "pin") throw new RoomError("OPERATION_ID_CONFLICT", "This operation ID already belongs to another action.");
        return { receipt: { ...previous.receipt, duplicate: true }, delta: null };
      }
      this.checkBudget(user.id);
      const message = input.messageId === null ? null : this.retained.find(item => item.id === input.messageId);
      if (input.messageId !== null && !message) throw new RoomError("MESSAGE_NOT_FOUND", "This message is no longer retained.");
      const changed = (this.publicPin?.message.id ?? null) !== input.messageId;
      let delta: RoomDelta | null = null;
      if (changed) {
        this.publicPin = message ? Object.freeze({ message, pinnedAt: this.clock(), pinnedBy: copyUser(user) }) : null;
        this.roomRevision += 1;
        delta = { roomId: "lobby", revision: this.roomRevision, change: { kind: "pin.changed", pin: this.publicPin }, evictedMessageIds: [], history: this.history() };
      }
      const receipt: PinReceipt = { operationId: input.operationId, messageId: input.messageId, appliedRevision: this.roomRevision, duplicate: false };
      this.remember(user.id, input.operationId, { kind: "pin", fingerprint, receipt });
      return { receipt, delta };
    });
  }

  exportState(): RoomState {
    return { epochId: this.epochId, revision: this.roomRevision, sequence: this.messageSequence, messages: this.retained, pin: this.publicPin,
      memberEvents: this.memberEvents,
      operations: [...this.operations].map(([userId, ledger]) => [userId, [...ledger]] as const) };
  }

  recordMemberEvent(event: MemberEvent): void {
    this.transaction(() => {
      this.memberEvents = Object.freeze([...this.memberEvents, Object.freeze({ ...event, user: copyUser(event.user) })].slice(-200));
    });
  }

  private restore(state: RoomState): void {
    this.roomRevision = state.revision;
    this.messageSequence = state.sequence;
    this.retained = Object.freeze([...state.messages]);
    this.serializedBytes = utf8Bytes(JSON.stringify(this.retained));
    this.publicPin = state.pin;
    this.memberEvents = Object.freeze([...(state.memberEvents ?? [])]);
    this.operations.clear();
    for (const [userId, ledger] of state.operations) this.operations.set(userId, new Map(ledger));
    this.operationCount = state.operations.reduce((count, [, ledger]) => count + ledger.length, 0);
  }

  private transaction<T>(mutation: () => T): T {
    const before = this.exportState();
    try {
      const result = mutation();
      const previousCount = before.operations.reduce((count, [, ledger]) => count + ledger.length, 0);
      const previousMemberEventId = before.memberEvents?.at(-1)?.id ?? null;
      const currentMemberEventId = this.memberEvents.at(-1)?.id ?? null;
      if (this.roomRevision !== before.revision || this.operationCount !== previousCount || previousMemberEventId !== currentMemberEventId) this.persist?.(this.exportState());
      return result;
    } catch (error) {
      this.restore(before);
      if (error instanceof RoomError) throw error;
      throw new RoomError("STORAGE_UNAVAILABLE", "Durable storage is temporarily unavailable. Try again shortly.", true);
    }
  }

  private validateState(): void {
    const snapshot = this.snapshot({ version: 0, members: [] }, { version: 0, entries: [] });
    const parsed = parseServerEvent({ v: 1, type: "room.snapshot", epochId: this.epochId, serverTime: this.clock(), requestId: randomUUID(), payload: { snapshot } });
    if (!parsed.ok || snapshotInvariantErrors(snapshot).length > 0 || !Number.isSafeInteger(this.messageSequence) || this.messageSequence < (this.retained.at(-1)?.sequence ?? 0)) throw new Error("Stored room state is invalid.");
    if (this.operations.size > LIMITS.activeSessions) throw new Error("Stored operation ledgers exceed capacity.");
    for (const [userId, ledger] of this.operations) {
      if (!wireId.test(userId) || ledger.size > LIMITS.acceptedOperationsPerSession) throw new Error("Stored operation ledger is invalid.");
      for (const [operationId, operation] of ledger) {
        if (!wireId.test(operationId) || !/^[0-9a-f]{64}$/.test(operation.fingerprint) || operation.receipt.operationId !== operationId) throw new Error("Stored operation receipt is invalid.");
        const type = operation.kind === "message" ? "message.accepted" : operation.kind === "reaction" ? "reaction.accepted" : operation.kind === "pin" ? "pin.accepted" : null;
        const receipt = parseServerEvent({ v: 1, type, epochId: this.epochId, serverTime: this.clock(), requestId: randomUUID(), payload: operation.receipt });
        if (!receipt.ok || operation.receipt.appliedRevision > this.roomRevision) throw new Error("Stored operation receipt is invalid.");
      }
    }
  }

  search(query: string, limit: number): SearchResponse {
    const normalized = query.trim();
    if (!normalized || Array.from(normalized).length > LIMITS.searchQueryCodePoints || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.searchResults) {
      throw new RoomError("BAD_REQUEST", "A bounded search query and result limit are required.");
    }
    const pattern = escapePattern(normalized);
    const results: SearchHit[] = [];
    let totalMatches = 0;
    for (let index = this.retained.length - 1; index >= 0; index -= 1) {
      const message = this.retained[index];
      if (!message) continue;
      const source = rawContent(message.content);
      const first = new RegExp(pattern, "iu").exec(source);
      if (!first) continue;
      totalMatches += 1;
      if (results.length >= limit) continue;
      const points = Array.from(source);
      let offset = 0;
      let pointIndex = 0;
      while (pointIndex < points.length && offset < first.index) {
        offset += points[pointIndex]?.length ?? 0;
        pointIndex += 1;
      }
      const start = Math.max(0, pointIndex - Math.floor(LIMITS.searchSnippetCodePoints / 3));
      const snippet = points.slice(start, start + LIMITS.searchSnippetCodePoints).join("");
      const matches: HighlightRange[] = [];
      for (const match of snippet.matchAll(new RegExp(pattern, "giu"))) {
        matches.push({ start: match.index, end: match.index + match[0].length });
        if (matches.length === 100) break;
      }
      results.push({ messageId: message.id, sequence: message.sequence, author: message.author,
        createdAt: message.createdAt, kind: message.content.kind, snippet, matches });
    }
    return { epochId: this.epochId, roomId: "lobby", query: normalized,
      asOfRevision: this.roomRevision, searchedAt: this.clock(), history: this.history(),
      totalMatches, truncated: totalMatches > results.length, results };
  }

  private checkRoom(roomId: string): void {
    if (roomId !== "lobby") throw new RoomError("ROOM_NOT_FOUND", "This room does not exist.");
  }

  private checkContent(content: SendMessageInput["content"]): void {
    if (!content || (content.kind !== "text" && content.kind !== "code")) throw new RoomError("BAD_REQUEST", "Text or code content is required.");
    const body = rawContent(content);
    if (typeof body !== "string" || !body.trim()) throw new RoomError("CONTENT_EMPTY", "Message content cannot be blank.");
    if (utf8Bytes(body) > LIMITS.messageBodyUtf8Bytes) throw new RoomError("CONTENT_TOO_LARGE", "Message content exceeds the byte limit.");
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(body)) throw new RoomError("BAD_REQUEST", "Message content contains an unsupported control character.");
    if (content.kind === "code" && !CODE_LANGUAGES.includes(content.language)) throw new RoomError("BAD_REQUEST", "This code language is not supported.");
  }

  private contains(messageId: string): boolean { return this.retained.some((message) => message.id === messageId); }

  private lookup(userId: string, operationId: string, fingerprint: string): Operation | undefined {
    const previous = this.operations.get(userId)?.get(operationId);
    if (previous && previous.fingerprint !== fingerprint) throw new RoomError("OPERATION_ID_CONFLICT", "This operation ID was already used with different content.");
    return previous;
  }

  private checkBudget(userId: string): void {
    if ((this.operations.get(userId)?.size ?? 0) >= LIMITS.acceptedOperationsPerSession) {
      throw new RoomError("SESSION_WRITE_LIMIT", "This session has reached its write limit. Leave and join again to continue.");
    }
  }

  private remember(userId: string, operationId: string, operation: Operation): void {
    let ledger = this.operations.get(userId);
    if (!ledger) { ledger = new Map(); this.operations.set(userId, ledger); }
    ledger.set(operationId, operation);
    this.operationCount += 1;
  }

  private commit(messages: ChatMessage[], change: RoomChange, revision: number): RoomDelta {
    const evictedMessageIds: string[] = [];
    let bytes = utf8Bytes(JSON.stringify(messages));
    while (messages.length > LIMITS.historyMessages || bytes > LIMITS.historyJsonUtf8Bytes) {
      const removed = messages.shift();
      if (!removed) break;
      evictedMessageIds.push(removed.id);
      bytes = utf8Bytes(JSON.stringify(messages));
    }
    this.retained = Object.freeze(messages);
    this.serializedBytes = bytes;
    this.roomRevision = revision;
    return { roomId: "lobby", revision, change, evictedMessageIds, history: this.history() };
  }
}

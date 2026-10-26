import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { PublicUser, SessionRole } from "../shared/domain.js";
import type { CreateSessionRequest, SessionCredential } from "../shared/http.js";
import { LIMITS } from "../shared/limits.js";
import { parseSessionCredential } from "../shared/validation.js";
import { StorageError } from "./database.js";

interface Identity {
  readonly tokenHash: string;
  readonly user: PublicUser;
  readonly expiresAt: number;
  readonly firstJoinedAt: number | null;
  readonly lastSeenAt: number;
}
export interface GuestSession {
  readonly tokenHash: string;
  readonly identityHash: string;
  readonly user: PublicUser;
  readonly role: SessionRole;
  readonly expiresAt: number;
  readonly displayNameChanged: boolean;
  socket: WebSocket | null;
}
export interface SessionState {
  readonly identities: readonly Identity[];
  readonly sessions: readonly Omit<GuestSession, "socket">[];
}
export class IdentityError extends Error {}

export class SessionStore {
  private readonly sessions = new Map<string, GuestSession>();
  private readonly identities = new Map<string, Identity>();

  constructor(private readonly ttlMs: number, state?: SessionState, private readonly persist?: (state: SessionState) => void) {
    if (state) {
      if (!Array.isArray(state.identities) || !Array.isArray(state.sessions) || state.identities.length > LIMITS.recoverableIdentities || state.sessions.length > LIMITS.activeSessions) throw new Error("Stored identity state exceeds capacity.");
      const identityUsers = new Set<string>();
      for (const identity of state.identities) {
        const check = parseSessionCredential({ protocolVersion: 1, epochId: randomUUID(), roomId: "lobby", self: identity.user, bearerToken: identity.tokenHash, expiresAt: identity.expiresAt, role: "guest" });
        if (!check.ok || !hex.test(identity.tokenHash) || !Number.isSafeInteger(identity.lastSeenAt) || identity.lastSeenAt < 0 || identity.expiresAt < identity.lastSeenAt || (identity.firstJoinedAt !== null && (!Number.isSafeInteger(identity.firstJoinedAt) || identity.firstJoinedAt < 0 || identity.firstJoinedAt > identity.lastSeenAt)) || this.identities.has(identity.tokenHash) || identityUsers.has(identity.user.id)) throw new Error("Stored identity is invalid.");
        this.identities.set(identity.tokenHash, identity);
        identityUsers.add(identity.user.id);
      }
      const users = new Set<string>();
      for (const session of state.sessions) {
        const check = parseSessionCredential({ protocolVersion: 1, epochId: randomUUID(), roomId: "lobby", self: session.user, bearerToken: session.tokenHash, expiresAt: session.expiresAt, role: session.role });
        const identity = this.identities.get(session.identityHash);
        if (!check.ok || !identity || identity.user.id !== session.user.id || !hex.test(session.tokenHash) || users.has(session.user.id) || this.sessions.has(session.tokenHash) || (session.role !== "guest" && session.role !== "admin")) throw new Error("Stored session is invalid.");
        users.add(session.user.id);
        this.sessions.set(session.tokenHash, { ...session, displayNameChanged: session.displayNameChanged === true, socket: null });
      }
    }
  }

  get size(): number { return this.sessions.size; }

  create(input: CreateSessionRequest, epochId: string, now: number, role: SessionRole): { session: GuestSession; credential: SessionCredential; superseded: readonly GuestSession[] } {
    const identityToken = input.identityToken ?? randomBytes(32).toString("hex");
    const identityHash = hash(identityToken);
    const previous = this.identities.get(identityHash);
    if (input.identityToken && (!previous || previous.expiresAt <= now)) throw new IdentityError("The saved identity has expired or is unavailable.");
    const superseded = [...this.sessions.values()].filter(session => session.identityHash === identityHash);
    if (this.sessions.size - superseded.length >= LIMITS.activeSessions) throw new IdentityError("The guest session capacity has been reached.");
    const bearerToken = randomBytes(32).toString("hex");
    const user: PublicUser = { id: previous?.user.id ?? randomUUID(), displayName: input.displayName, avatarSeed: previous?.user.avatarSeed ?? randomBytes(8).toString("hex") };
    const identity: Identity = { tokenHash: identityHash, user, expiresAt: now + LIMITS.identityTtlMs, firstJoinedAt: previous?.firstJoinedAt ?? null, lastSeenAt: now };
    const session: GuestSession = { tokenHash: hash(bearerToken), identityHash, user, role, expiresAt: now + this.ttlMs, displayNameChanged: previous !== undefined && previous.user.displayName !== input.displayName, socket: null };
    this.mutate(() => {
      for (const old of superseded) this.sessions.delete(old.tokenHash);
      this.pruneIdentities(now);
      if (!previous && this.identities.size >= LIMITS.recoverableIdentities) {
        const active = new Set([...this.sessions.values()].map(item => item.identityHash));
        const oldest = [...this.identities.values()].filter(item => !active.has(item.tokenHash)).sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
        if (!oldest) throw new IdentityError("The saved identity capacity has been reached.");
        this.identities.delete(oldest.tokenHash);
      }
      this.identities.set(identityHash, identity);
      this.sessions.set(session.tokenHash, session);
    });
    return { session, superseded, credential: { protocolVersion: 1, epochId, roomId: "lobby", self: user, bearerToken, expiresAt: session.expiresAt, identityToken, role } };
  }

  markJoined(session: GuestSession, now: number): { kind: "joined" | "returned"; displayNameChanged: boolean } {
    const identity = this.identities.get(session.identityHash);
    if (!identity) throw new IdentityError("The saved identity is unavailable.");
    this.mutate(() => this.identities.set(identity.tokenHash, { ...identity, firstJoinedAt: identity.firstJoinedAt ?? now, lastSeenAt: now, expiresAt: now + LIMITS.identityTtlMs }));
    return { kind: identity.firstJoinedAt === null ? "joined" : "returned", displayNameChanged: session.displayNameChanged };
  }

  find(token: string): GuestSession | undefined { return hex.test(token) ? this.sessions.get(hash(token)) : undefined; }
  remove(session: GuestSession, persist = true): void {
    if (persist) this.mutate(() => { this.sessions.delete(session.tokenHash); });
    else this.sessions.delete(session.tokenHash);
  }
  expired(now: number): GuestSession[] { return [...this.sessions.values()].filter(session => session.expiresAt <= now); }
  all(): readonly GuestSession[] { return [...this.sessions.values()]; }
  exportState(): SessionState {
    return { identities: [...this.identities.values()], sessions: [...this.sessions.values()].map(({ socket: _socket, ...session }) => session) };
  }
  private mutate(mutation: () => unknown): void {
    const beforeSessions = new Map(this.sessions);
    const beforeIdentities = new Map(this.identities);
    try { mutation(); this.persist?.(this.exportState()); }
    catch (error) {
      this.sessions.clear(); this.identities.clear();
      for (const [key, value] of beforeSessions) this.sessions.set(key, value);
      for (const [key, value] of beforeIdentities) this.identities.set(key, value);
      if (error instanceof IdentityError) throw error;
      throw new StorageError();
    }
  }
  private pruneIdentities(now: number): void {
    const active = new Set([...this.sessions.values()].map(session => session.identityHash));
    for (const [key, identity] of this.identities) if (identity.expiresAt <= now && !active.has(key)) this.identities.delete(key);
  }
}
const hex = /^[0-9a-f]{64}$/;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

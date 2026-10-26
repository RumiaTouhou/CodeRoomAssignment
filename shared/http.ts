import type {
  EpochId, HistoryWindow, MessageId, MessageSequence, PublicUser,
  RoomId, RoomRevision, SessionRole, UnixMs,
} from "./domain.js";

/** POST /api/sessions — JSON, no pre-existing credential required. */
export interface CreateSessionRequest {
  readonly displayName: string;
  readonly adminPassword?: string;
  readonly identityToken?: string;
}
/** This type belongs to the service layer. Never pass bearerToken into UI props. */
export interface SessionCredential {
  readonly protocolVersion: 1;
  readonly epochId: EpochId;
  readonly roomId: RoomId;
  readonly self: PublicUser;
  /** 32 random bytes encoded as 64 lowercase hex characters; secret. */
  readonly bearerToken: string;
  readonly expiresAt: UnixMs;
  readonly identityToken?: string;
  readonly role?: SessionRole;
}
export interface PublicLimits {
  readonly messageBodyUtf8Bytes: number;
  readonly historyMessages: number;
  readonly historyJsonUtf8Bytes: number;
  readonly searchResults: number;
  readonly typingTtlMs: number;
  readonly ackTimeoutMs: number;
}
/** GET /api/health — no tokens, users, message content or environment secrets. */
export interface HealthResponse { readonly ok: true; readonly protocolVersion: 1 }
/** GET /api/rooms/lobby/search?q=<encoded literal>&limit=50 */
export interface SearchRequest {
  readonly query: string;
  readonly limit: number;
}
/** Half-open UTF-16 offsets into the EXACT accompanying text; never HTML. */
export interface HighlightRange { readonly start: number; readonly end: number }
export interface SearchHit {
  readonly messageId: MessageId;
  readonly sequence: MessageSequence;
  readonly author: PublicUser;
  readonly createdAt: UnixMs;
  readonly kind: "text" | "code";
  readonly snippet: string;
  readonly matches: readonly HighlightRange[];
}
export interface SearchResponse {
  readonly epochId: EpochId;
  readonly roomId: RoomId;
  readonly query: string;
  readonly asOfRevision: RoomRevision;
  readonly searchedAt: UnixMs;
  readonly history: HistoryWindow;
  /** All matches in the retained window, not only the returned subset. */
  readonly totalMatches: number;
  readonly truncated: boolean;
  /** Newest sequence first. */
  readonly results: readonly SearchHit[];
}
/**
 * Other routes: DELETE /api/session -> 204 (revoke token and close its connection).
 * POST /api/sessions: 201; search/health: 200.
 * Authenticated HTTP uses Authorization: Bearer <token>; credentials: omit.
 * Error bodies use HttpErrorBody.
 */

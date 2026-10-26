export const ERROR_CODES = [
  "BAD_REQUEST", "UNSUPPORTED_VERSION", "UNAUTHENTICATED", "SESSION_EXPIRED",
  "SESSION_REPLACED", "EPOCH_MISMATCH", "ROOM_FULL", "RESOURCE_LIMIT",
  "ROOM_NOT_FOUND", "MESSAGE_NOT_FOUND", "CONTENT_EMPTY", "CONTENT_TOO_LARGE",
  "RATE_LIMITED", "OPERATION_ID_CONFLICT", "SESSION_WRITE_LIMIT", "REACTION_LIMIT",
  "INTERNAL_ERROR", "FORBIDDEN", "STORAGE_UNAVAILABLE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface Problem {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** A retryable error does NOT imply that the first attempt was not applied. */
  readonly outcome: "not-applied" | "unknown";
  readonly retryAfterMs?: number;
  readonly field?: string;
}
export interface HttpErrorBody {
  readonly error: Problem;
  readonly requestId: string;
}
export const WS_CLOSE = {
  normal: 1000,
  invalidPayload: 1007,
  tooLarge: 1009,
  authenticationRequired: 4401,
  forbiddenOrigin: 4403,
  unsupportedProtocol: 4406,
  sessionReplaced: 4409,
  sessionExpired: 4410,
} as const;

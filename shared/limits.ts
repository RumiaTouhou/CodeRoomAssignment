/** Shared bounds enforced at transport, storage and presentation boundaries. */
export const PROTOCOL_VERSION = 1 as const;
export const ROOM_ID = "lobby" as const;
export const LIMITS = {
  nicknameCodePoints: 24,
  messageBodyUtf8Bytes: 16_384,
  clientFrameUtf8Bytes: 65_536,
  historyMessages: 300,
  historyJsonUtf8Bytes: 1_048_576,
  snapshotFrameUtf8Bytes: 2_097_152,
  activeSessions: 64,
  recoverableIdentities: 1_024,
  identityTtlMs: 30 * 24 * 60 * 60 * 1_000,
  presenceGraceMs: 10_000,
  onlineUsers: 32,
  acceptedOperationsPerSession: 1_000,
  reactionUsersPerEmoji: 64,
  pendingMessages: 20,
  searchQueryCodePoints: 100,
  searchResults: 50,
  searchSnippetCodePoints: 180,
  quotePreviewCodePoints: 160,
  sessionTtlMs: 12 * 60 * 60 * 1_000,
  authenticateWithinMs: 5_000,
  ackTimeoutMs: 8_000,
  typingRenewMs: 1_500,
  typingIdleMs: 1_500,
  typingTtlMs: 4_000,
  heartbeatIntervalMs: 25_000,
  heartbeatGraceMs: 10_000,
  soundCooldownMs: 1_200,
  groupWindowMs: 60_000,
  searchDebounceMs: 250,
  reconnectBaseMs: 1_000,
  reconnectCapMs: 30_000,
  reconnectMaxAttempts: 10,
} as const;
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "✅"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
export const CODE_LANGUAGES = [
  "plaintext", "javascript", "typescript", "python", "json", "html", "css", "bash", "sql",
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

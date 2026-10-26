import type {
  ConnectionId, EpochId, MessageReceipt, OperationId, PresenceState, PublicUser,
  ReactionReceipt, RequestId, RoomDelta, RoomSnapshot, SendMessageInput,
  SetReactionInput, TypingState, UnixMs, SetPinInput, PinReceipt, MemberEvent, SessionRole,
} from "./domain.js";
import type { Problem } from "./errors.js";
import type { PublicLimits } from "./http.js";

type BeforeAuth<T extends string, P> = {
  readonly v: 1;
  readonly type: T;
  readonly requestId: RequestId;
  readonly payload: P;
};
type ClientEnvelope<T extends string, P> = BeforeAuth<T, P> & {
  readonly epochId: EpochId;
};
export type ClientEvent =
  | BeforeAuth<"session.authenticate", { readonly token: string }>
  | ClientEnvelope<"room.sync", { readonly roomId: "lobby" }>
  | ClientEnvelope<"message.send", SendMessageInput>
  | ClientEnvelope<"reaction.set", SetReactionInput>
  | ClientEnvelope<"pin.set", SetPinInput>
  | ClientEnvelope<"typing.set", { readonly roomId: "lobby"; readonly active: boolean }>;

type ServerEnvelope<T extends string, P> = {
  readonly v: 1;
  readonly type: T;
  readonly epochId: EpochId;
  readonly serverTime: UnixMs;
  readonly payload: P;
};
type ServerResponse<T extends string, P> = ServerEnvelope<T, P> & {
  readonly requestId: RequestId;
};
export type ServerEvent =
  | ServerResponse<"session.ready", {
      readonly connectionId: ConnectionId;
      readonly self: PublicUser;
      readonly expiresAt: UnixMs;
      readonly limits: PublicLimits;
      readonly snapshot: RoomSnapshot;
      readonly role?: SessionRole;
    }>
  | ServerResponse<"room.snapshot", { readonly snapshot: RoomSnapshot }>
  | ServerEnvelope<"room.delta", RoomDelta>
  | ServerResponse<"message.accepted", MessageReceipt>
  | ServerResponse<"reaction.accepted", ReactionReceipt>
  | ServerResponse<"pin.accepted", PinReceipt>
  | ServerEnvelope<"member.event", MemberEvent>
  | ServerEnvelope<"presence.state", PresenceState>
  | ServerEnvelope<"typing.state", TypingState>
  | ServerEnvelope<"request.error", {
      readonly requestId: RequestId | null;
      readonly operationId: OperationId | null;
      readonly error: Problem;
    }>
  | ServerEnvelope<"session.ended", {
      readonly reason: "expired" | "replaced" | "revoked";
    }>;

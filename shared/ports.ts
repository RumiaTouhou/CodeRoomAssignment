import type { EpochId, MessageId, PublicUser, SendMessageInput, SetPinInput, SetReactionInput } from "./domain.js";
import type { CreateSessionRequest, SearchRequest, SearchResponse, SessionCredential } from "./http.js";
import type { ServerEvent } from "./ws.js";

/** Service-layer ports. UI components must not depend on these. */
export interface HttpPort {
  createSession(input: CreateSessionRequest, signal?: AbortSignal): Promise<SessionCredential>;
  revokeSession(credential: SessionCredential, signal?: AbortSignal): Promise<void>;
  search(credential: SessionCredential, input: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
}
export interface TransportObservation {
  readonly type: "connecting" | "open" | "closed" | "error";
  readonly closeCode?: number;
}
export interface RealtimePort {
  connect(credential: SessionCredential): void;
  disconnect(): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
  observeTransport(listener: (observation: TransportObservation) => void): () => void;
  /** Dispatch result only; never interpreted as server confirmation. */
  sendMessage(epochId: EpochId, input: SendMessageInput): "queued" | "not-connected";
  setReaction(epochId: EpochId, input: SetReactionInput): "queued" | "not-connected";
  setPin?(epochId: EpochId, input: SetPinInput): "queued" | "not-connected";
  setTyping(epochId: EpochId, active: boolean): void;
  synchronize(epochId: EpochId): void;
}
export interface NavigationPort {
  jumpToMessage(id: MessageId, reason: "search" | "quote"): void;
  jumpToLatest(): void;
  restoreReadingPosition(): void;
}
/** Authoritative guest identity is obtained from HTTP/WS, never from a display name. */
export interface ActiveIdentity { readonly epochId: EpochId; readonly user: PublicUser }

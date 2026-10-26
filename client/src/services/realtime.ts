import type { ClientEvent, ServerEvent } from "../../../shared/ws.js";
import type { SessionCredential } from "../../../shared/http.js";
import { LIMITS } from "../../../shared/limits.js";
import { parseServerJson } from "../../../shared/validation.js";

export interface RealtimeHandlers {
  readonly onEvent: (event: ServerEvent) => void;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onInvalid: () => void;
}
export interface RealtimeAdapter {
  connect(credential: SessionCredential): void;
  disconnect(): void;
  send(event: ClientEvent): boolean;
}
export class RealtimeClient implements RealtimeAdapter {
  private socket: WebSocket | null = null;
  private generation = 0;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly origin: string, private readonly handlers: RealtimeHandlers) {}
  connect(credential: SessionCredential) {
    this.disconnect();
    const generation = this.generation;
    const url = new URL("/ws", this.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try { socket = new WebSocket(url); } catch { this.handlers.onClose(); return; }
    this.socket = socket;
    this.authTimer = setTimeout(() => { if (generation === this.generation && this.socket === socket) socket.close(); }, LIMITS.authenticateWithinMs + 2_000);
    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.handlers.onOpen();
      this.send({ v: 1, type: "session.authenticate", requestId: crypto.randomUUID(), payload: { token: credential.bearerToken } });
    });
    socket.addEventListener("message", event => {
      if (generation !== this.generation) return;
      if (typeof event.data !== "string") { this.handlers.onInvalid(); socket.close(); return; }
      const parsed = parseServerJson(event.data);
      if (!parsed.ok) { this.handlers.onInvalid(); socket.close(); return; }
      if (parsed.value.type === "session.ready") this.clearAuthTimer();
      this.handlers.onEvent(parsed.value);
    });
    socket.addEventListener("close", () => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.clearAuthTimer();
      this.handlers.onClose();
    });
    socket.addEventListener("error", () => { if (generation === this.generation) socket.close(); });
  }
  disconnect() {
    this.generation += 1;
    this.clearAuthTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close(1000);
  }
  send(event: ClientEvent): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(event)); return true; } catch { return false; }
  }
  private clearAuthTimer() { if (this.authTimer) clearTimeout(this.authTimer); this.authTimer = null; }
}

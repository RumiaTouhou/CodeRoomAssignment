import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ClientEvent, ServerEvent } from "../shared/ws.js";
import type { PresenceState, PublicUser, TypingState } from "../shared/domain.js";
import type { ErrorCode, Problem } from "../shared/errors.js";
import { WS_CLOSE } from "../shared/errors.js";
import { LIMITS } from "../shared/limits.js";
import { parseClientJson, parseCreateSession, parseSearchRequest } from "../shared/validation.js";
import { DEFAULT_RATE_LIMITS, RateLimiter, type ServerRateLimits } from "./limits.js";
import { IdentityError, SessionStore, type GuestSession, type SessionState } from "./sessions.js";
import { Room, RoomError, type RoomState } from "./room.js";
import { serveStatic } from "./static.js";
import { Database, StorageError } from "./database.js";

export interface ChatServerOptions {
  readonly allowedOrigins?: readonly string[];
  readonly staticDir?: string | false;
  readonly clock?: () => number;
  readonly sessionTtlMs?: number;
  readonly authenticationTimeoutMs?: number;
  readonly typingTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatGraceMs?: number;
  readonly rateLimits?: Partial<ServerRateLimits>;
  readonly dataFile?: string;
  readonly adminPassword?: string;
  readonly presenceGraceMs?: number;
}

interface Connection {
  readonly socket: WebSocket;
  readonly address: string;
  readonly id: string;
  readonly authTimer: ReturnType<typeof setTimeout>;
  session: GuestSession | null;
  authenticated: boolean;
  nextPingAt: number;
  pingDeadline: number | null;
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly problem: Problem) { super(problem.message); }
}

function problem(code: ErrorCode, message: string, retryable = false): Problem {
  return { code, message, retryable, outcome: "not-applied" };
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (error: Error) => { if (!settled) { settled = true; rejectBody(error); } };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > 4096) {
        chunks.length = 0;
        fail(new HttpFailure(413, problem("CONTENT_TOO_LARGE", "The request body is too large.")));
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch { rejectBody(new HttpFailure(400, problem("BAD_REQUEST", "The request body must contain valid JSON."))); }
    });
    request.on("aborted", () => fail(new Error("Request aborted")));
    request.on("error", () => fail(new Error("Request stream failed")));
  });
}

const wireId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeIds(text: string): { requestId: string | null; operationId: string | null } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return { requestId: null, operationId: null };
    const record = value as Record<string, unknown>;
    const payload = record.payload && typeof record.payload === "object" ? record.payload as Record<string, unknown> : {};
    return {
      requestId: typeof record.requestId === "string" && wireId.test(record.requestId) ? record.requestId : null,
      operationId: typeof payload.operationId === "string" && wireId.test(payload.operationId) ? payload.operationId : null,
    };
  } catch { return { requestId: null, operationId: null }; }
}

export function createChatServer(options: ChatServerOptions = {}) {
  const clock = options.clock ?? Date.now;
  const rates = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const origins = new Set(options.allowedOrigins ?? ["http://localhost:5173", "http://127.0.0.1:5173"]);
  const database = new Database(options.dataFile);
  let room: Room;
  let sessions: SessionStore;
  try {
    const state = database.read<RoomState>("room");
    room = new Room({ clock, ...(state ? { state } : {}), persistent: database.persistent, persist: value => database.write("room", value) });
    sessions = new SessionStore(options.sessionTtlMs ?? LIMITS.sessionTtlMs, database.read<SessionState>("sessions"), value => database.write("sessions", value));
    if (!state) database.write("room", room.exportState());
  } catch (error) { database.close(); throw error; }
  const limiter = new RateLimiter();
  const connections = new Set<Connection>();
  const typing = new Map<string, number>();
  const present = new Map<string, { user: PublicUser; session: GuestSession; leaveAt: number | null }>();
  let presenceVersion = 0;
  let typingVersion = 0;
  let closing = false;
  const staticDir = options.staticDir === false ? false : options.staticDir ?? resolve(process.cwd(), "client/dist");
  const authTimeout = options.authenticationTimeoutMs ?? LIMITS.authenticateWithinMs;
  const typingTtl = options.typingTtlMs ?? LIMITS.typingTtlMs;
  const heartbeatInterval = options.heartbeatIntervalMs ?? LIMITS.heartbeatIntervalMs;
  const heartbeatGrace = options.heartbeatGraceMs ?? LIMITS.heartbeatGraceMs;
  const presenceGrace = options.presenceGraceMs ?? LIMITS.presenceGraceMs;
  const adminDigest = createHash("sha256").update(options.adminPassword ?? "114514").digest();
  const webSockets = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: LIMITS.clientFrameUtf8Bytes });

  function originAllowed(origin: string | undefined, request: IncomingMessage, required: boolean): boolean {
    if (!origin) return !required;
    if (origins.has(origin)) return true;
    const host = request.headers.host;
    return !!host && (origin === `http://${host}` || origin === `https://${host}`);
  }

  function envelope<T extends ServerEvent["type"]>(type: T, payload: Extract<ServerEvent, { type: T }>["payload"], requestId?: string): ServerEvent {
    return { v: 1, type, epochId: room.epochId, serverTime: clock(), payload, ...(requestId ? { requestId } : {}) } as ServerEvent;
  }

  function enqueue(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > LIMITS.snapshotFrameUtf8Bytes * 2) { socket.close(1013, "Client is not keeping up"); return; }
    socket.send(JSON.stringify(event), error => { if (error) socket.terminate(); });
  }

  function broadcast(event: ServerEvent): void {
    for (const connection of connections) {
      if (connection.authenticated && connection.session?.socket === connection.socket) enqueue(connection.socket, event);
    }
  }

  function presence(): PresenceState {
    return { version: presenceVersion, members: [...present.values()].map(member => member.user) };
  }

  function typingState(): TypingState {
    const online = new Set([...present.values()].filter(member => member.session.socket?.readyState === WebSocket.OPEN).map(member => member.user.id));
    const now = clock();
    return { version: typingVersion, entries: [...typing].filter(([userId, expiresAt]) => online.has(userId) && expiresAt > now).map(([userId, expiresAt]) => ({ userId, expiresAt })) };
  }

  function clearTyping(userId: string): void {
    if (typing.delete(userId)) { typingVersion += 1; broadcast(envelope("typing.state", typingState())); }
  }

  function endSession(session: GuestSession, reason: "expired" | "revoked"): void {
    const socket = session.socket;
    const sessionState = sessions.exportState();
    const roomState = room.exportState();
    database.writeMany([
      ["sessions", { ...sessionState, sessions: sessionState.sessions.filter(value => value.tokenHash !== session.tokenHash) }],
      ["room", { ...roomState, operations: roomState.operations.filter(([userId]) => userId !== session.user.id) }],
    ]);
    sessions.remove(session, false);
    room.forgetUser(session.user.id, false);
    session.socket = null;
    clearTyping(session.user.id);
    if (socket) {
      enqueue(socket, envelope("session.ended", { reason }));
      socket.close(reason === "expired" ? WS_CLOSE.sessionExpired : WS_CLOSE.normal, "Session ended");
    }
    removePresence(session.user.id);
  }

  function removePresence(userId: string): void {
    const member = present.get(userId);
    if (!member) return;
    if (closing) return;
    const event = { id: randomUUID(), kind: "left" as const, user: member.user, occurredAt: clock() };
    try { room.recordMemberEvent(event); }
    catch {
      member.leaveAt = clock();
      return;
    }
    present.delete(userId);
    presenceVersion += 1;
    broadcast(envelope("presence.state", presence()));
    broadcast(envelope("member.event", event));
  }

  function expireSessions(): void {
    for (const session of sessions.expired(clock())) endSession(session, "expired");
  }

  function authenticateHttp(request: IncomingMessage): GuestSession {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const session = sessions.find(token);
    if (!session) throw new HttpFailure(401, problem("UNAUTHENTICATED", "A valid guest session is required."));
    if (session.expiresAt <= clock()) {
      endSession(session, "expired");
      throw new HttpFailure(401, problem("SESSION_EXPIRED", "The guest session has expired."));
    }
    return session;
  }

  function consume(category: keyof ServerRateLimits, identity: string): void {
    const windowMs = category === "session" || category === "connection" ? 60_000 : 10_000;
    const wait = limiter.consume(`${category}:${identity}`, rates[category], windowMs, clock());
    if (wait !== null) throw new HttpFailure(429, { ...problem("RATE_LIMITED", "Too many requests. Try again shortly.", true), retryAfterMs: wait });
  }

  function json(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(value));
  }

  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const requestId = randomUUID();
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    response.setHeader("X-Request-Id", requestId);
    void (async () => {
      if (closing) throw new HttpFailure(503, problem("RESOURCE_LIMIT", "The service is shutting down.", true));
      const url = new URL(request.url ?? "/", "http://localhost");
      const origin = request.headers.origin;
      if (!originAllowed(origin, request, false)) throw new HttpFailure(403, problem("BAD_REQUEST", "The request origin is not allowed."));
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        response.setHeader("Access-Control-Max-Age", "600");
        response.statusCode = 204; response.end(); return;
      }
      if (url.pathname === "/api/health" && request.method === "GET") { json(response, 200, { ok: true, protocolVersion: 1 }); return; }
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        consume("session", request.socket.remoteAddress ?? "unknown");
        if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new HttpFailure(400, problem("BAD_REQUEST", "Content-Type must be application/json."));
        const parsed = parseCreateSession(await readJson(request));
        if (!parsed.ok) throw new HttpFailure(400, problem("BAD_REQUEST", "Use a display name of 1 to 24 characters without control characters."));
        expireSessions();
        const password = parsed.value.adminPassword ?? "";
        if (password && !timingSafeEqual(createHash("sha256").update(password).digest(), adminDigest)) throw new HttpFailure(403, problem("FORBIDDEN", "The administrator password is incorrect."));
        if (sessions.size >= LIMITS.activeSessions && !parsed.value.identityToken) throw new HttpFailure(503, problem("RESOURCE_LIMIT", "The guest session capacity has been reached.", true));
        let created: ReturnType<SessionStore["create"]>;
        try { created = sessions.create(parsed.value, room.epochId, clock(), password ? "admin" : "guest"); }
        catch (error) { if (error instanceof IdentityError) throw new HttpFailure(parsed.value.identityToken ? 401 : 503, problem(parsed.value.identityToken ? "UNAUTHENTICATED" : "RESOURCE_LIMIT", error.message)); throw error; }
        const { credential, session, superseded } = created;
        for (const old of superseded) {
          const socket = old.socket; old.socket = null;
          if (socket) { enqueue(socket, envelope("session.ended", { reason: "replaced" })); socket.close(WS_CLOSE.sessionReplaced, "Session replaced"); }
        }
        const member = present.get(session.user.id);
        if (member) { present.set(session.user.id, { user: session.user, session, leaveAt: clock() + presenceGrace }); clearTyping(session.user.id); }
        json(response, 201, credential); return;
      }
      if (url.pathname === "/api/session" && request.method === "DELETE") {
        endSession(authenticateHttp(request), "revoked"); response.statusCode = 204; response.end(); return;
      }
      if (url.pathname === "/api/rooms/lobby/search" && request.method === "GET") {
        const session = authenticateHttp(request);
        consume("search", session.user.id);
        if ([...url.searchParams.keys()].some(key => key !== "q" && key !== "limit") || url.searchParams.getAll("q").length !== 1 || url.searchParams.getAll("limit").length > 1) throw new HttpFailure(400, problem("BAD_REQUEST", "Search accepts one q parameter and an optional limit."));
        const limitText = url.searchParams.get("limit") ?? String(LIMITS.searchResults);
        if (!/^[1-9][0-9]*$/.test(limitText)) throw new HttpFailure(400, problem("BAD_REQUEST", "The search result limit is invalid."));
        const parsed = parseSearchRequest({ query: url.searchParams.get("q"), limit: Number(limitText) });
        if (!parsed.ok) throw new HttpFailure(400, problem("BAD_REQUEST", "Search requires 1 to 100 characters and a result limit from 1 to 50."));
        json(response, 200, room.search(parsed.value.query, parsed.value.limit)); return;
      }
      if (url.pathname.startsWith("/api/rooms/")) throw new HttpFailure(404, problem("ROOM_NOT_FOUND", "The room does not exist."));
      if (url.pathname.startsWith("/api/")) throw new HttpFailure(404, problem("BAD_REQUEST", "The API route does not exist."));
      if (staticDir && (request.method === "GET" || request.method === "HEAD") && await serveStatic(staticDir, url.pathname, request.method, response)) return;
      throw new HttpFailure(404, problem("BAD_REQUEST", "The requested resource does not exist."));
    })().catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      const failure = error instanceof HttpFailure ? error : error instanceof StorageError ? new HttpFailure(503, problem("STORAGE_UNAVAILABLE", error.message, true)) : error instanceof RoomError ? new HttpFailure(error.problem.code === "STORAGE_UNAVAILABLE" ? 503 : 400, error.problem) : new HttpFailure(500, { ...problem("INTERNAL_ERROR", "The request could not be completed.", true), outcome: "unknown" });
      if (failure.problem.retryAfterMs) response.setHeader("Retry-After", Math.ceil(failure.problem.retryAfterMs / 1000));
      json(response, failure.status, { error: failure.problem, requestId });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });

  function rejectUpgrade(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (closing || connections.size >= LIMITS.onlineUsers * 2 + 16) { rejectUpgrade(socket, 503); return; }
      if (url.pathname !== "/ws" || url.search) { rejectUpgrade(socket, 400); return; }
      if (!originAllowed(request.headers.origin, request, true)) { rejectUpgrade(socket, 403); return; }
      const address = request.socket.remoteAddress ?? "unknown";
      consume("connection", address);
      if ([...connections].filter(connection => connection.address === address && !connection.authenticated).length >= 4) { rejectUpgrade(socket, 429); return; }
      webSockets.handleUpgrade(request, socket, head, ws => {
        const connection: Connection = {
          socket: ws, address, id: randomUUID(), session: null, authenticated: false,
          authTimer: setTimeout(() => ws.close(WS_CLOSE.authenticationRequired, "Authentication timed out"), authTimeout),
          nextPingAt: clock() + heartbeatInterval, pingDeadline: null,
        };
        connection.authTimer.unref();
        connections.add(connection);
        ws.on("pong", () => { connection.pingDeadline = null; });
        ws.on("error", () => {});
        ws.on("close", () => {
          clearTimeout(connection.authTimer); connections.delete(connection);
          const session = connection.session;
          if (session?.socket === ws) {
            session.socket = null;
            clearTyping(session.user.id);
            const member = present.get(session.user.id);
            if (member && !closing) member.leaveAt = clock() + presenceGrace;
          }
        });
        ws.on("message", (data, isBinary) => handleFrame(connection, data, isBinary));
      });
    } catch (error: unknown) { rejectUpgrade(socket, error instanceof HttpFailure ? error.status : 400); }
  });

  function errorEvent(connection: Connection, requestId: string | null, operationId: string | null, error: Problem): void {
    enqueue(connection.socket, envelope("request.error", { requestId, operationId, error }));
  }

  function handleFrame(connection: Connection, data: RawData, isBinary: boolean): void {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
    const ids = safeIds(text);
    try {
      consume("frame", connection.session?.user.id ?? connection.id);
      if (isBinary) { errorEvent(connection, null, null, problem("BAD_REQUEST", "Only JSON text frames are supported.")); connection.socket.close(WS_CLOSE.invalidPayload, "Text frames required"); return; }
      const parsed = parseClientJson(text);
      if (!parsed.ok) {
        const code: ErrorCode = parsed.issue.includes("UTF-8 byte limit") || parsed.issue.includes("too large") ? "CONTENT_TOO_LARGE" : parsed.issue.includes("blank") ? "CONTENT_EMPTY" : parsed.issue.includes("$client.v") ? "UNSUPPORTED_VERSION" : "BAD_REQUEST";
        errorEvent(connection, ids.requestId, ids.operationId, problem(code, code === "CONTENT_TOO_LARGE" ? "The message exceeds the allowed size." : code === "CONTENT_EMPTY" ? "Messages cannot contain only whitespace." : "The event has an invalid format."));
        return;
      }
      const event = parsed.value;
      if (event.type === "session.authenticate") { authenticateSocket(connection, event); return; }
      const session = connection.session;
      if (!connection.authenticated || !session) { errorEvent(connection, event.requestId, ids.operationId, problem("UNAUTHENTICATED", "Authenticate before sending room events.")); connection.socket.close(WS_CLOSE.authenticationRequired, "Authentication required"); return; }
      if (session.socket !== connection.socket) { errorEvent(connection, event.requestId, ids.operationId, problem("SESSION_REPLACED", "The session is active in another window.")); connection.socket.close(WS_CLOSE.sessionReplaced, "Session replaced"); return; }
      if (session.expiresAt <= clock()) { endSession(session, "expired"); return; }
      if (event.epochId !== room.epochId) { errorEvent(connection, event.requestId, ids.operationId, problem("EPOCH_MISMATCH", "The room history has restarted. Join again to continue.")); return; }
      switch (event.type) {
        case "room.sync": enqueue(connection.socket, envelope("room.snapshot", { snapshot: room.snapshot(presence(), typingState()) }, event.requestId)); break;
        case "message.send": {
          if (!room.hasOperation(session.user.id, event.payload.operationId)) consume("message", session.user.id);
          const result = room.send(session.user, event.payload);
          if (result.delta) broadcast(envelope("room.delta", result.delta));
          enqueue(connection.socket, envelope("message.accepted", result.receipt, event.requestId));
          clearTyping(session.user.id); break;
        }
        case "reaction.set": {
          if (!room.hasOperation(session.user.id, event.payload.operationId)) consume("reaction", session.user.id);
          const result = room.react(session.user, event.payload);
          if (result.delta) broadcast(envelope("room.delta", result.delta));
          enqueue(connection.socket, envelope("reaction.accepted", result.receipt, event.requestId)); break;
        }
        case "pin.set": {
          if (!room.hasOperation(session.user.id, event.payload.operationId)) consume("reaction", session.user.id);
          const result = room.pin(session.user, event.payload, session.role === "admin");
          if (result.delta) broadcast(envelope("room.delta", result.delta));
          enqueue(connection.socket, envelope("pin.accepted", result.receipt, event.requestId)); break;
        }
        case "typing.set": {
          consume("typing", session.user.id);
          if (event.payload.active) { typing.set(session.user.id, clock() + typingTtl); typingVersion += 1; broadcast(envelope("typing.state", typingState())); }
          else clearTyping(session.user.id);
          break;
        }
      }
    } catch (error: unknown) {
      const detail = error instanceof RoomError || error instanceof HttpFailure ? error.problem : error instanceof StorageError ? problem("STORAGE_UNAVAILABLE", error.message, true) : { ...problem("INTERNAL_ERROR", "The event could not be completed.", true), outcome: "unknown" as const };
      errorEvent(connection, ids.requestId, ids.operationId, detail);
    }
  }

  function authenticateSocket(connection: Connection, event: Extract<ClientEvent, { type: "session.authenticate" }>): void {
    if (connection.authenticated) { errorEvent(connection, event.requestId, null, problem("BAD_REQUEST", "The connection is already authenticated.")); return; }
    const session = sessions.find(event.payload.token);
    if (!session) { errorEvent(connection, event.requestId, null, problem("UNAUTHENTICATED", "The guest session is invalid.")); connection.socket.close(WS_CLOSE.authenticationRequired, "Invalid session"); return; }
    if (session.expiresAt <= clock()) { endSession(session, "expired"); errorEvent(connection, event.requestId, null, problem("SESSION_EXPIRED", "The guest session has expired.")); connection.socket.close(WS_CLOSE.sessionExpired, "Session expired"); return; }
    const previous = session.socket;
    const wasOnline = present.has(session.user.id);
    if (!wasOnline && presence().members.length >= LIMITS.onlineUsers) { errorEvent(connection, event.requestId, null, problem("ROOM_FULL", "The room is full. Try again shortly.", true)); connection.socket.close(1013, "Room full"); return; }
    const announcement = wasOnline ? null : sessions.markJoined(session, clock());
    const memberRecord = announcement ? { id: randomUUID(), kind: announcement.kind, displayNameChanged: announcement.displayNameChanged, user: session.user, occurredAt: clock() } : null;
    if (memberRecord) room.recordMemberEvent(memberRecord);
    session.socket = connection.socket;
    present.set(session.user.id, { user: session.user, session, leaveAt: null });
    connection.session = session;
    clearTimeout(connection.authTimer);
    if (!wasOnline) presenceVersion += 1;
    if (previous && previous !== connection.socket) {
      clearTyping(session.user.id);
      enqueue(previous, envelope("session.ended", { reason: "replaced" }));
      previous.close(WS_CLOSE.sessionReplaced, "Session replaced");
    }
    enqueue(connection.socket, envelope("session.ready", {
      connectionId: connection.id, self: session.user, expiresAt: session.expiresAt, role: session.role,
      limits: { messageBodyUtf8Bytes: LIMITS.messageBodyUtf8Bytes, historyMessages: LIMITS.historyMessages, historyJsonUtf8Bytes: LIMITS.historyJsonUtf8Bytes, searchResults: LIMITS.searchResults, typingTtlMs: typingTtl, ackTimeoutMs: LIMITS.ackTimeoutMs },
      snapshot: room.snapshot(presence(), typingState()),
    }, event.requestId));
    connection.authenticated = true;
    broadcast(envelope("presence.state", presence()));
    if (memberRecord) broadcast(envelope("member.event", memberRecord));
  }

  const maintenance = setInterval(() => {
    const now = clock();
    try { expireSessions(); } catch { /* Expiry is retried while storage remains unavailable. */ }
    limiter.prune(now);
    for (const [userId, member] of present) if (member.leaveAt !== null && member.leaveAt <= now) removePresence(userId);
    let typingChanged = false;
    for (const [userId, expiresAt] of typing) if (expiresAt <= now) { typing.delete(userId); typingChanged = true; }
    if (typingChanged) { typingVersion += 1; broadcast(envelope("typing.state", typingState())); }
    for (const connection of connections) {
      if (connection.pingDeadline !== null && connection.pingDeadline <= now) { connection.socket.terminate(); continue; }
      if (connection.socket.readyState === WebSocket.OPEN && connection.pingDeadline === null && connection.nextPingAt <= now) {
        connection.pingDeadline = now + heartbeatGrace; connection.nextPingAt = now + heartbeatInterval;
        connection.socket.ping(undefined, false, error => { if (error) connection.socket.terminate(); });
      }
    }
  }, Math.max(10, Math.min(250, typingTtl, heartbeatInterval, heartbeatGrace, presenceGrace || 10)));
  maintenance.unref();

  return {
    server,
    room,
    async listen(port = 0, host = "127.0.0.1"): Promise<{ port: number; origin: string; webSocketUrl: string }> {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => { server.off("error", rejectListen); resolveListen(); });
      });
      const address = server.address() as AddressInfo;
      const authority = `${host.includes(":") ? `[${host}]` : host}:${address.port}`;
      return { port: address.port, origin: `http://${authority}`, webSocketUrl: `ws://${authority}/ws` };
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true; clearInterval(maintenance);
      for (const connection of connections) { clearTimeout(connection.authTimer); connection.socket.terminate(); }
      await Promise.all([
        new Promise<void>(done => webSockets.close(() => done())),
        new Promise<void>(done => { if (server.listening) server.close(() => done()); else done(); server.closeIdleConnections(); }),
      ]);
      database.close();
    },
  };
}

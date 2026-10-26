import type { Problem } from "../../../shared/errors.js";
import type { CreateSessionRequest, SearchRequest, SearchResponse, SessionCredential } from "../../../shared/http.js";
import type { HttpPort } from "../../../shared/ports.js";
import { parseSearchResponse, parseSessionCredential } from "../../../shared/validation.js";

export class HttpFailure extends Error {
  constructor(readonly problem: Problem) { super(problem.message); this.name = "HttpFailure"; }
}

export class HttpClient implements HttpPort {
  constructor(readonly origin: string) {}
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (init.signal?.aborted) abort.abort();
    init.signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; abort.abort(); }, 12_000);
    try {
    const response = await fetch(new URL(path, this.origin), { ...init, signal: abort.signal, credentials: "omit", cache: "no-store" });
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length > 2_097_152) throw new Error("The server response exceeded the supported size.");
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error("The server returned an invalid response."); }
    if (!response.ok) {
      const problem = (data as { error?: Partial<Problem> })?.error;
      throw new HttpFailure({ code: problem?.code ?? "INTERNAL_ERROR", message: typeof problem?.message === "string" ? problem.message : "The request could not be completed.", retryable: problem?.retryable ?? response.status >= 500, outcome: problem?.outcome === "unknown" ? "unknown" : "not-applied" });
    }
    return data;
    } catch (error) {
      if (timedOut) throw new Error("The request timed out. Check the connection and try again.");
      throw error;
    } finally {
      clearTimeout(deadline);
      init.signal?.removeEventListener("abort", cancel);
    }
  }
  async createSession(input: CreateSessionRequest, signal?: AbortSignal): Promise<SessionCredential> {
    const data = await this.request("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), ...(signal ? { signal } : {}) });
    const parsed = parseSessionCredential(data);
    if (!parsed.ok) throw new Error("The server returned an invalid session.");
    return parsed.value;
  }
  async revokeSession(credential: SessionCredential, signal?: AbortSignal): Promise<void> {
    await this.request("/api/session", { method: "DELETE", headers: { Authorization: `Bearer ${credential.bearerToken}` }, ...(signal ? { signal } : {}) });
  }
  async search(credential: SessionCredential, input: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    const query = new URLSearchParams({ q: input.query, limit: String(input.limit) });
    const data = await this.request(`/api/rooms/lobby/search?${query}`, { headers: { Authorization: `Bearer ${credential.bearerToken}` }, ...(signal ? { signal } : {}) });
    const parsed = parseSearchResponse(data);
    if (!parsed.ok) throw new Error("The server returned invalid search results.");
    return parsed.value;
  }
}

export function backendOrigin(): string {
  const configured = import.meta.env?.VITE_API_ORIGIN?.trim();
  return new URL(configured || window.location.origin).origin;
}

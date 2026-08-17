import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../errors.js";
import type { StreamSessionManager } from "../sessions/session-manager.js";
import type { StreamSpawnerRegistry } from "../spawners/spawner.js";
import type { CreateStreamInput } from "../types.js";

type ApiKeys = Map<string, string>;
type RateWindow = { startedAt: number; count: number };

function configuredKeys(environment: NodeJS.ProcessEnv): ApiKeys {
  const keys = new Map<string, string>();
  if (environment.TOMO_STREAM_API_KEY && environment.TOMO_STREAM_API_KEY.length >= 24) keys.set("default", environment.TOMO_STREAM_API_KEY);
  if (environment.TOMO_STREAM_API_KEYS) {
    try {
      const parsed = JSON.parse(environment.TOMO_STREAM_API_KEYS) as Record<string, unknown>;
      for (const [client, value] of Object.entries(parsed)) if (typeof value === "string" && value.length >= 24) keys.set(client, value);
    } catch { throw new Error("TOMO_STREAM_API_KEYS must be a JSON object"); }
  }
  return keys;
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticate(request: IncomingMessage, keys: ApiKeys): string | null {
  const received = request.headers["x-api-key"];
  if (typeof received !== "string") return null;
  for (const [client, secret] of keys) if (equalSecret(received, secret)) return client;
  return null;
}

async function body<T>(request: IncomingMessage): Promise<T> {
  let raw = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 32 * 1024) throw new HttpError("request body is too large", 413, "payload_too_large");
  }
  try { return JSON.parse(raw || "{}") as T; }
  catch { throw new HttpError("request body must be valid JSON", 400, "invalid_json"); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export function createApiHandler(
  sessions: StreamSessionManager,
  spawners: StreamSpawnerRegistry,
  environment: NodeJS.ProcessEnv = process.env,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const keys = configuredKeys(environment);
  const rateLimit = Math.max(0, Number.parseInt(environment.TOMO_STREAM_RATE_LIMIT ?? "120", 10) || 120);
  const windows = new Map<string, RateWindow>();
  let apiRequests = 0;
  let authFailures = 0;
  let rateLimited = 0;
  return async (request, response) => {
    apiRequests += 1;
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type, x-api-key");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/health") { json(response, 200, { status: "ok", service: "tomo-streaming-control-plane" }); return; }
    if (request.method === "GET" && path === "/api/v1/stream-servers") {
      json(response, 200, { apiVersion: "1", runtime: "stream-server", streamServers: spawners.list() });
      return;
    }
    if (path !== "/api/v1/metrics" && path !== "/api/v1/streams" && !path.startsWith("/api/v1/streams/")) { json(response, 404, { error: { code: "not_found", message: "route not found" } }); return; }
    if (keys.size === 0) { json(response, 503, { error: { code: "api_disabled", message: "TOMO_STREAM_API_KEY is not configured" } }); return; }
    const client = authenticate(request, keys);
    if (!client) { authFailures += 1; json(response, 401, { error: { code: "invalid_api_key", message: "a valid x-api-key header is required" } }); return; }
    if (rateLimit > 0) {
      const now = Date.now();
      const current = windows.get(client);
      const window = !current || now - current.startedAt >= 60_000 ? { startedAt: now, count: 1 } : { ...current, count: current.count + 1 };
      windows.set(client, window);
      if (windows.size > 10_000) for (const [name, entry] of windows) if (now - entry.startedAt >= 60_000) windows.delete(name);
      if (window.count > rateLimit) {
        rateLimited += 1;
        response.setHeader("retry-after", "60");
        json(response, 429, { error: { code: "rate_limited", message: "request rate limit exceeded" } });
        return;
      }
    }
    try {
      if (request.method === "GET" && path === "/api/v1/metrics") {
        json(response, 200, { service: "tomo-streaming-control-plane", metrics: {
          ...sessions.metrics(),
          apiRequests,
          authFailures,
          rateLimited,
        } });
        return;
      }
      if (path === "/api/v1/streams" && request.method === "GET") { json(response, 200, { sessions: await sessions.list(client) }); return; }
      if (path === "/api/v1/streams" && request.method === "POST") {
        json(response, 201, { session: await sessions.create(client, await body<CreateStreamInput>(request)) });
        return;
      }
      const action = path.match(/^\/api\/v1\/streams\/([^/]+)\/actions$/);
      if (action && request.method === "POST") {
        const input = await body<{ action?: string }>(request);
        if (!input.action || !["pause", "resume", "restart"].includes(input.action)) throw new HttpError("invalid action", 400, "invalid_action");
        json(response, 200, { session: await sessions.action(client, decodeURIComponent(action[1]), input.action as "pause" | "resume" | "restart") });
        return;
      }
      const item = path.match(/^\/api\/v1\/streams\/([^/]+)$/);
      if (item && request.method === "GET") {
        const session = await sessions.get(client, decodeURIComponent(item[1]));
        if (!session) throw new HttpError("stream session not found", 404, "session_not_found");
        json(response, 200, { session });
        return;
      }
      if (item && request.method === "DELETE") {
        if (!(await sessions.remove(client, decodeURIComponent(item[1])))) throw new HttpError("stream session not found", 404, "session_not_found");
        response.writeHead(204); response.end(); return;
      }
      throw new HttpError("route not found", 404, "not_found");
    } catch (error) {
      const known = error instanceof HttpError;
      json(response, known ? error.status : 500, { error: { code: known ? error.code : "internal_error", message: error instanceof Error ? error.message : "internal error" } });
    }
  };
}

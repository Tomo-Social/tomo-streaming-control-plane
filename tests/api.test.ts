import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createApiHandler } from "../src/http/api.js";
import type { StreamSessionManager } from "../src/sessions/session-manager.js";
import type { StreamSpawnerRegistry } from "../src/spawners/spawner.js";

const fakeSessions = {
  async list(owner: string) { return [{ id: "one", owner }]; },
  async create(owner: string, input: unknown) { return { id: "two", owner, input }; },
  async get() { return null; },
  async action() { throw new Error("unused"); },
  async remove() { return false; },
  metrics() { return { sessions: 1, connectedPeers: 2, byStatus: { starting: 0, running: 1, paused: 0, offline: 0 } }; },
} as unknown as StreamSessionManager;
const fakeSpawners = { list: () => [{ id: "camera-stream-server" }] } as unknown as StreamSpawnerRegistry;
const key = "test-stream-key-with-24-characters";
const handler = createApiHandler(fakeSessions, fakeSpawners, { TOMO_STREAM_API_KEY: key });
const server = createServer((request, response) => { void handler(request, response); });
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("discovery is public and sessions are isolated behind API keys", async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/stream-servers`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/streams`)).status, 401);
  const response = await fetch(`${baseUrl}/api/v1/streams`, { headers: { "x-api-key": key } });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { sessions: Array<{ owner: string }> }).sessions[0].owner, "default");
});

test("control plane creates generic sessions without social identity", async () => {
  const response = await fetch(`${baseUrl}/api/v1/streams`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ type: "desktop-stream-server", config: { display: ":0" } }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as { session: { owner: string; input: { type: string } } };
  assert.equal(payload.session.owner, "default");
  assert.equal(payload.session.input.type, "desktop-stream-server");
});

test("metrics are protected by the integration key", async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/metrics`)).status, 401);
  const response = await fetch(`${baseUrl}/api/v1/metrics`, { headers: { "x-api-key": key } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { metrics: { connectedPeers: number } }).metrics.connectedPeers, 2);
});

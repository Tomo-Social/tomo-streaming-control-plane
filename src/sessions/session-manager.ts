import { randomBytes } from "node:crypto";
import type Docker from "dockerode";
import { HttpError } from "../errors.js";
import type { CreateStreamInput, PublicStreamSession, SessionStatus } from "../types.js";
import type { StreamSpawnerRegistry } from "../spawners/spawner.js";

type SessionRecord = {
  id: string;
  type: string;
  owner: string;
  name: string | null;
  source: Record<string, unknown>;
  containerId: string;
  playerToken: string;
  hostToken: string;
  status: SessionStatus;
  connectedCount: number;
  updatedAt: string;
};

export interface StreamSessionMetrics {
  sessions: number;
  connectedPeers: number;
  byStatus: Record<SessionStatus, number>;
}

export class StreamSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly docker: Docker,
    private readonly spawners: StreamSpawnerRegistry,
    private readonly maxSessions = 4,
    private readonly instanceId = "default",
  ) {}

  async reconcileOrphans(): Promise<void> {
    const containers = await this.docker.listContainers({
      all: false,
      filters: JSON.stringify({ label: ["tomo.runtime=stream-server", `tomo.control-plane.instance=${this.instanceId}`] }),
    });
    for (const info of containers) await this.docker.getContainer(info.Id).stop({ t: 2 }).catch(() => {});
  }

  async list(owner: string): Promise<PublicStreamSession[]> {
    return Promise.all([...this.sessions.values()].filter((session) => session.owner === owner).map((session) => this.snapshot(session)));
  }

  async get(owner: string, id: string): Promise<PublicStreamSession | null> {
    const session = this.sessions.get(id);
    return session?.owner === owner ? this.snapshot(session) : null;
  }

  async create(owner: string, input: CreateStreamInput): Promise<PublicStreamSession> {
    if (this.sessions.size >= this.maxSessions) throw new HttpError("stream capacity exceeded", 503, "capacity_exceeded");
    if (!input || typeof input.type !== "string") throw new HttpError("type is required", 400, "invalid_type");
    const spawner = this.spawners.resolve(input.type);
    if (!spawner) throw new HttpError(`unknown stream-server type: ${input.type}`, 400, "unsupported_stream_server");
    const id = randomBytes(8).toString("hex");
    const playerToken = randomBytes(32).toString("base64url");
    const hostToken = randomBytes(32).toString("base64url");
    const { container, source } = await spawner.prepare(id, hostToken, input.config ?? {});
    try {
      await container.start();
    } catch (error) {
      await container.remove({ force: true }).catch(() => {});
      throw error;
    }
    const record: SessionRecord = {
      id,
      type: input.type,
      owner,
      name: typeof input.name === "string" ? input.name.trim().slice(0, 60) || null : null,
      source,
      containerId: container.id,
      playerToken,
      hostToken,
      status: "starting",
      connectedCount: 0,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, record);
    return this.snapshot(record);
  }

  async action(owner: string, id: string, action: "pause" | "resume" | "restart"): Promise<PublicStreamSession> {
    const session = this.owned(owner, id);
    const container = this.docker.getContainer(session.containerId);
    const state = (await container.inspect()).State;
    if (action === "pause") {
      if (!state.Paused) await container.pause();
      session.status = "paused";
    } else if (action === "resume") {
      if (state.Paused) await container.unpause();
      session.status = "running";
    } else {
      if (state.Paused) await container.unpause();
      await container.restart({ t: 2 });
      session.status = "starting";
    }
    session.updatedAt = new Date().toISOString();
    return this.snapshot(session);
  }

  async remove(owner: string, id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return false;
    this.sessions.delete(id);
    await this.docker.getContainer(session.containerId).stop({ t: 2 }).catch(() => {});
    return true;
  }

  authorize(room: string, role: "host" | "player", token: string): boolean {
    const session = this.sessions.get(room);
    if (!session) return false;
    return role === "host" ? token === session.hostToken : token === session.playerToken;
  }

  setConnectedCount(room: string, count: number): void {
    const session = this.sessions.get(room);
    if (!session) return;
    session.connectedCount = Math.max(0, count);
    if (session.status !== "paused") session.status = "running";
    session.updatedAt = new Date().toISOString();
  }

  metrics(): StreamSessionMetrics {
    const byStatus: Record<SessionStatus, number> = { starting: 0, running: 0, paused: 0, offline: 0 };
    let connectedPeers = 0;
    for (const session of this.sessions.values()) {
      byStatus[session.status] += 1;
      connectedPeers += session.connectedCount;
    }
    return { sessions: this.sessions.size, connectedPeers, byStatus };
  }

  async reapIdle(maxIdleMs: number): Promise<number> {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) return 0;
    const cutoff = Date.now() - maxIdleMs;
    const idle = [...this.sessions.values()].filter((session) =>
      session.connectedCount === 0 && Date.parse(session.updatedAt) <= cutoff,
    );
    for (const session of idle) {
      this.sessions.delete(session.id);
      await this.docker.getContainer(session.containerId).stop({ t: 2 }).catch(() => {});
    }
    return idle.length;
  }

  private owned(owner: string, id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new HttpError("stream session not found", 404, "session_not_found");
    return session;
  }

  private async snapshot(session: SessionRecord): Promise<PublicStreamSession> {
    try {
      const state = (await this.docker.getContainer(session.containerId).inspect()).State;
      session.status = state.Paused ? "paused" : state.Running ? (session.status === "starting" ? "starting" : "running") : state.Restarting ? "starting" : "offline";
    } catch { session.status = "offline"; }
    return {
      id: session.id,
      type: session.type,
      owner: session.owner,
      status: session.status,
      name: session.name,
      source: session.source,
      runtime: {
        connectedCount: session.connectedCount,
        activity: session.connectedCount > 0 ? "active" : "empty",
        updatedAt: session.updatedAt,
      },
      connection: { signalingPath: "/signaling", room: session.id, accessToken: session.playerToken },
    };
  }
}

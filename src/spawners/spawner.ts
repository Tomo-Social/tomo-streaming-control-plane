import type Docker from "dockerode";
import type { PreparedStream, StreamServerManifest } from "../types.js";

export type ContainerSpec = {
  image: string;
  env: Record<string, string | undefined>;
  binds?: string[];
  devices?: Array<{ hostPath: string; containerPath: string; permissions?: string }>;
  networkMode?: string;
  cpuCores: number;
  memoryBytes: number;
  labels?: Record<string, string>;
};

export type SpawnResult = {
  container: Docker.Container;
  source: Record<string, unknown>;
};

export abstract class DockerStreamSpawner {
  abstract readonly manifest: StreamServerManifest;

  constructor(protected readonly docker: Docker, private readonly instanceId: string) {}

  protected abstract normalizeConfig(config: Record<string, unknown>, room: string): Record<string, unknown>;
  protected abstract containerSpec(request: PreparedStream): Promise<ContainerSpec>;

  async prepare(room: string, hostToken: string, rawConfig: Record<string, unknown>): Promise<SpawnResult> {
    const config = this.normalizeConfig(rawConfig, room);
    const spec = await this.containerSpec({ room, hostToken, config });
    const env = Object.entries(spec.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
      .map(([key, value]) => `${key}=${value}`);
    const container = await this.docker.createContainer({
      Image: spec.image,
      Env: env,
      Labels: {
        "tomo.runtime": "stream-server",
        "tomo.control-plane.instance": this.instanceId,
        "tomo.room": room,
        "tomo.stream-server.type": this.manifest.id,
        "tomo.stream-server.version": this.manifest.version,
        ...spec.labels,
      },
      HostConfig: {
        AutoRemove: true,
        Binds: spec.binds ?? [],
        Devices: spec.devices?.map((device) => ({
          PathOnHost: device.hostPath,
          PathInContainer: device.containerPath,
          CgroupPermissions: device.permissions ?? "rwm",
        })) ?? [],
        NetworkMode: spec.networkMode ?? "host",
        NanoCpus: Math.max(0.1, spec.cpuCores) * 1_000_000_000,
        Memory: spec.memoryBytes,
        MemorySwap: spec.memoryBytes,
      },
    });
    return { container, source: config };
  }
}

export class StreamSpawnerRegistry {
  private readonly spawners = new Map<string, DockerStreamSpawner>();

  register(spawner: DockerStreamSpawner): void {
    if (this.spawners.has(spawner.manifest.id)) throw new Error(`duplicate stream-server: ${spawner.manifest.id}`);
    this.spawners.set(spawner.manifest.id, spawner);
  }

  resolve(id: string): DockerStreamSpawner | null {
    return this.spawners.get(id) ?? null;
  }

  list(): StreamServerManifest[] {
    return [...this.spawners.values()].map(({ manifest }) => manifest);
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import type Docker from "dockerode";
import { CameraStreamSpawner, DesktopStreamSpawner } from "../src/spawners/av-spawners.js";
import { StreamSpawnerRegistry } from "../src/spawners/spawner.js";

test("camera and desktop are discoverable plugins", () => {
  const docker = {} as Docker;
  const options = { image: "av:test", signalingUrl: "ws://control-plane/signaling" };
  const registry = new StreamSpawnerRegistry();
  registry.register(new CameraStreamSpawner(docker, options));
  registry.register(new DesktopStreamSpawner(docker, options));
  assert.deepEqual(registry.list().map(({ id }) => id), ["camera-stream-server", "desktop-stream-server"]);
});

test("camera spawner maps device and emits only streaming runtime configuration", async () => {
  let created: Record<string, any> | null = null;
  const docker = { async createContainer(input: Record<string, any>) { created = input; return { id: "container" }; } } as unknown as Docker;
  const spawner = new CameraStreamSpawner(docker, {
    image: "av:test", signalingUrl: "ws://control-plane/signaling", cameraDeviceHost: "/dev/video2", inputSocketHostDir: "/host/input",
  });
  const result = await spawner.prepare("room-1", "host-token", { videoDevice: "/dev/video0" });
  assert.equal(result.source.kind, "camera");
  assert.equal(created!.Labels["tomo.stream-server.type"], "camera-stream-server");
  assert.deepEqual(created!.HostConfig.Devices, [{ PathOnHost: "/dev/video2", PathInContainer: "/dev/video0", CgroupPermissions: "r" }]);
  assert.ok(created!.Env.includes("SESSION_ACCESS_TOKEN=host-token"));
  assert.ok(created!.Env.includes("INPUT_SOCKET_PATH=/input/room-1.sock"));
});

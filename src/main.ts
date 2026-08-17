import { createServer } from "node:http";
import Docker from "dockerode";
import { createApiHandler } from "./http/api.js";
import { StreamSessionManager } from "./sessions/session-manager.js";
import { SignalingHub } from "./signaling/signaling-hub.js";
import { CameraStreamSpawner, DesktopStreamSpawner } from "./spawners/av-spawners.js";
import { StreamSpawnerRegistry } from "./spawners/spawner.js";

const port = Number(process.env.PORT ?? 8090);
const instanceId = process.env.TOMO_STREAM_INSTANCE_ID ?? "default";
const docker = new Docker();
const spawners = new StreamSpawnerRegistry();
const options = {
  instanceId,
  image: process.env.AV_STREAM_SERVER_IMAGE ?? "tomo-av-stream-server:local",
  signalingUrl: process.env.STREAM_SERVER_SIGNALING_URL ?? `ws://localhost:${port}/signaling`,
  publicIp: process.env.PUBLIC_IP,
  turnUrl: process.env.TURN_URL,
  turnUsername: process.env.TURN_USERNAME,
  turnPassword: process.env.TURN_PASSWORD,
  cameraDeviceHost: process.env.CAMERA_DEVICE_HOST,
  x11SocketHost: process.env.X11_SOCKET_HOST,
  pulseSocketHost: process.env.PULSE_SOCKET_HOST,
  inputSocketHostDir: process.env.INPUT_SOCKET_HOST_DIR,
};
spawners.register(new CameraStreamSpawner(docker, options));
spawners.register(new DesktopStreamSpawner(docker, options));

const sessions = new StreamSessionManager(docker, spawners, Number(process.env.MAX_STREAM_SESSIONS ?? 4), instanceId);
const api = createApiHandler(sessions, spawners);
const server = createServer((request, response) => { void api(request, response); });
new SignalingHub(server, sessions);
const emptySessionTimeoutSeconds = Number(process.env.EMPTY_SESSION_TIMEOUT_SECONDS ?? 0);
const idleReaper = emptySessionTimeoutSeconds > 0
  ? setInterval(() => { void sessions.reapIdle(emptySessionTimeoutSeconds * 1000); }, 60_000)
  : undefined;

await sessions.reconcileOrphans();
server.listen(port, "0.0.0.0", () => console.log(`[TOMO STREAMING] control plane listening on :${port}`));

async function shutdown(): Promise<void> {
  if (idleReaper) clearInterval(idleReaper);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });

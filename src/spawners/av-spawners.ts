import type Docker from "dockerode";
import { HttpError } from "../errors.js";
import type { PreparedStream } from "../types.js";
import { DockerStreamSpawner, type ContainerSpec } from "./spawner.js";

export type AvSpawnerOptions = {
  instanceId?: string;
  image: string;
  signalingUrl: string;
  publicIp?: string;
  turnUrl?: string;
  turnUsername?: string;
  turnPassword?: string;
  cameraDeviceHost?: string;
  x11SocketHost?: string;
  pulseSocketHost?: string;
  inputSocketHostDir?: string;
};

function integer(config: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = config[key] ?? fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(`${key} must be an integer between ${min} and ${max}`, 400, `invalid_${key}`);
  }
  return Number(value);
}

function commonConfig(config: Record<string, unknown>, room: string): Record<string, unknown> {
  const bitrate = typeof config.bitrate === "string" ? config.bitrate : "2000K";
  if (!/^\d{2,6}[KkMm]$/.test(bitrate)) throw new HttpError("bitrate must look like 2000K or 4M", 400, "invalid_bitrate");
  const inputSocketPath = typeof config.inputSocketPath === "string" ? config.inputSocketPath : `/input/${room}.sock`;
  if (!/^\/input\/[A-Za-z0-9._-]+\.sock$/.test(inputSocketPath) || inputSocketPath.includes("..")) {
    throw new HttpError("inputSocketPath must be a socket below /input", 400, "invalid_input_socket");
  }
  return {
    width: integer(config, "width", 1280, 320, 3840),
    height: integer(config, "height", 720, 240, 2160),
    fps: integer(config, "fps", 30, 1, 60),
    bitrate,
    captureAudio: config.captureAudio !== false,
    audioDevice: typeof config.audioDevice === "string" ? config.audioDevice : null,
    inputSocketPath,
  };
}

abstract class AvSpawner extends DockerStreamSpawner {
  constructor(docker: Docker, protected readonly options: AvSpawnerOptions) { super(docker, options.instanceId ?? "default"); }

  protected avSpec(source: "camera" | "desktop", request: PreparedStream, sourceEnv: Record<string, string>, binds: string[], devices: ContainerSpec["devices"] = []): ContainerSpec {
    if (this.options.pulseSocketHost) binds.push(`${this.options.pulseSocketHost}:/run/pulse:ro`);
    if (this.options.inputSocketHostDir) binds.push(`${this.options.inputSocketHostDir}:/input`);
    return {
      image: this.options.image,
      binds,
      devices,
      networkMode: "host",
      cpuCores: 2,
      memoryBytes: 1024 * 1024 * 1024,
      labels: { "tomo.source.kind": source },
      env: {
        STREAM_SOURCE: source,
        SIGNALING_URL: this.options.signalingUrl,
        SIGNALING_ROOM: request.room,
        SESSION_ACCESS_TOKEN: request.hostToken,
        PUBLIC_IP: this.options.publicIp,
        VIDEO_WIDTH: String(request.config.width),
        VIDEO_HEIGHT: String(request.config.height),
        VIDEO_FPS: String(request.config.fps),
        VIDEO_BITRATE: String(request.config.bitrate),
        CAPTURE_AUDIO: request.config.captureAudio ? "1" : "0",
        AUDIO_DEVICE: request.config.audioDevice ? String(request.config.audioDevice) : undefined,
        INPUT_SOCKET_PATH: this.options.inputSocketHostDir ? String(request.config.inputSocketPath) : undefined,
        PULSE_SERVER: this.options.pulseSocketHost ? "unix:/run/pulse/native" : undefined,
        TURN_URL: this.options.turnUrl,
        TURN_USERNAME: this.options.turnUsername,
        TURN_PASSWORD: this.options.turnPassword,
        ...sourceEnv,
      },
    };
  }
}

export class CameraStreamSpawner extends AvSpawner {
  readonly manifest = {
    id: "camera-stream-server", version: "1", name: "Camera Stream Server",
    sourceKinds: ["camera", "v4l2"], media: { video: true, audio: true, input: "data-channel" as const },
  };

  protected normalizeConfig(config: Record<string, unknown>, room: string): Record<string, unknown> {
    const videoDevice = typeof config.videoDevice === "string" ? config.videoDevice : "/dev/video0";
    if (!/^\/dev\/video\d+$/.test(videoDevice)) throw new HttpError("videoDevice must be a V4L2 device", 400, "invalid_video_device");
    return { kind: "camera", ...commonConfig(config, room), videoDevice };
  }

  protected async containerSpec(request: PreparedStream): Promise<ContainerSpec> {
    const device = String(request.config.videoDevice);
    return this.avSpec("camera", request, { VIDEO_DEVICE: device }, [], [
      { hostPath: this.options.cameraDeviceHost ?? device, containerPath: device, permissions: "r" },
    ]);
  }
}

export class DesktopStreamSpawner extends AvSpawner {
  readonly manifest = {
    id: "desktop-stream-server", version: "1", name: "Desktop Stream Server",
    sourceKinds: ["desktop", "x11"], media: { video: true, audio: true, input: "data-channel" as const },
  };

  protected normalizeConfig(config: Record<string, unknown>, room: string): Record<string, unknown> {
    const display = typeof config.display === "string" ? config.display : ":0";
    if (!/^:\d+(?:\.\d+)?$/.test(display)) throw new HttpError("display must look like :0 or :0.0", 400, "invalid_display");
    return { kind: "desktop", ...commonConfig(config, room), display };
  }

  protected async containerSpec(request: PreparedStream): Promise<ContainerSpec> {
    const binds = this.options.x11SocketHost ? [`${this.options.x11SocketHost}:/tmp/.X11-unix:ro`] : [];
    return this.avSpec("desktop", request, { DISPLAY: String(request.config.display) }, binds);
  }
}

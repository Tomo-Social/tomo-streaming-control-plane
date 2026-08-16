export type InputTransport = "none" | "data-channel" | "websocket";

export type StreamServerManifest = {
  id: string;
  version: string;
  name: string;
  sourceKinds: string[];
  media: { video: boolean; audio: boolean; input: InputTransport };
};

export type CreateStreamInput = {
  type: string;
  name?: string;
  config?: Record<string, unknown>;
};

export type SessionStatus = "starting" | "running" | "paused" | "offline";

export type PublicStreamSession = {
  id: string;
  type: string;
  owner: string;
  status: SessionStatus;
  name: string | null;
  source: Record<string, unknown>;
  runtime: { connectedCount: number; activity: "empty" | "active"; updatedAt: string };
  connection: { signalingPath: "/signaling"; room: string; accessToken: string };
};

export type PreparedStream = {
  room: string;
  hostToken: string;
  config: Record<string, unknown>;
};

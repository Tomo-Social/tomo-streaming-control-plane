import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { StreamSessionManager } from "../sessions/session-manager.js";

type SignalMessage = {
  type?: "join" | "offer" | "answer" | "candidate" | "leave";
  room?: string;
  role?: string;
  username?: string;
  accessToken?: string;
  to?: string;
  payload?: unknown;
};

type Peer = {
  id: string;
  socket: WebSocket;
  alive: boolean;
  room?: string;
  role?: "host" | "player";
  playerNumber?: number;
  username?: string;
};

export class SignalingHub {
  private readonly peers = new Map<string, Peer>();
  private readonly usedNumbers = new Map<string, Set<number>>();
  private readonly webSockets: WebSocketServer;

  constructor(server: Server, private readonly sessions: StreamSessionManager) {
    this.webSockets = new WebSocketServer({ server });
    this.webSockets.on("connection", (socket, request) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/signaling") {
        socket.close(4404, "not found");
        return;
      }
      this.handle(socket);
    });
    const heartbeat = setInterval(() => this.heartbeat(), 30_000);
    server.once("close", () => clearInterval(heartbeat));
  }

  private handle(socket: WebSocket): void {
    const peer: Peer = { id: randomUUID(), socket, alive: true };
    this.peers.set(peer.id, peer);
    socket.on("pong", () => { peer.alive = true; });
    socket.on("message", (raw) => this.onMessage(peer, raw.toString()));
    socket.on("close", () => this.disconnect(peer));
  }

  private onMessage(peer: Peer, raw: string): void {
    let message: SignalMessage;
    try { message = JSON.parse(raw) as SignalMessage; }
    catch { this.send(peer, { type: "leave", payload: { reason: "invalid_json" } }); return; }
    if (!message.type || !["join", "offer", "answer", "candidate", "leave"].includes(message.type)) return;
    if (message.type === "join") {
      if (peer.room) return;
      const room = typeof message.room === "string" && message.room.length <= 128 ? message.room : "";
      const role = message.role === "host" ? "host" : "player";
      if (!room || !this.sessions.authorize(room, role, message.accessToken ?? "")) {
        this.send(peer, { type: "leave", room, payload: { reason: "invalid_session_token" } });
        peer.socket.close(4403, "invalid session token");
        return;
      }
      peer.room = room;
      peer.role = role;
      peer.username = typeof message.username === "string" ? message.username.slice(0, 32) : undefined;
      if (role === "player") peer.playerNumber = this.allocatePlayer(room);
      const payload = { peerId: peer.id, playerNumber: peer.playerNumber, role, username: peer.username };
      this.send(peer, { type: "join", room, payload });
      this.broadcast(room, peer.id, { type: "join", room, payload });
      for (const other of this.peers.values()) {
        if (other.id !== peer.id && other.room === room && other.role === "player") {
          this.send(peer, { type: "join", room, payload: { peerId: other.id, playerNumber: other.playerNumber, role: "player", username: other.username } });
        }
      }
      this.refreshCount(room);
      return;
    }
    if (!peer.room) return;
    if (message.type === "leave") { peer.socket.close(1000, "left"); return; }
    const target = typeof message.to === "string" ? this.peers.get(message.to) : undefined;
    if (!target || target.room !== peer.room) return;
    this.send(target, { type: message.type, room: peer.room, from: peer.id, payload: message.payload });
  }

  private disconnect(peer: Peer): void {
    const room = peer.room;
    if (room) this.broadcast(room, peer.id, { type: "leave", room, payload: { peerId: peer.id } });
    this.peers.delete(peer.id);
    if (room && peer.playerNumber !== undefined) this.usedNumbers.get(room)?.delete(peer.playerNumber);
    if (room) this.refreshCount(room);
  }

  private allocatePlayer(room: string): number {
    const used = this.usedNumbers.get(room) ?? new Set<number>();
    this.usedNumbers.set(room, used);
    for (let number = 1; number <= 255; number += 1) {
      if (!used.has(number)) { used.add(number); return number; }
    }
    throw new Error("room has no available player numbers");
  }

  private refreshCount(room: string): void {
    this.sessions.setConnectedCount(room, [...this.peers.values()].filter((peer) => peer.room === room && peer.role === "player").length);
  }

  private send(peer: Peer, message: Record<string, unknown>): void {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message));
  }

  private broadcast(room: string, except: string, message: Record<string, unknown>): void {
    for (const peer of this.peers.values()) if (peer.room === room && peer.id !== except) this.send(peer, message);
  }

  private heartbeat(): void {
    for (const peer of this.peers.values()) {
      if (!peer.alive) { peer.socket.terminate(); continue; }
      peer.alive = false;
      peer.socket.ping();
    }
  }
}

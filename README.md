# Tomo Streaming Control Plane

Control plane independiente para crear y operar sesiones interactivas de video, audio e input. No contiene código de la red social Tomo.

## Frontera del producto

| Incluido | Excluido |
| --- | --- |
| WebRTC signaling | Cuentas y perfiles |
| Tokens host/player por sesión | Amistades y presencia social |
| API de stream sessions | Mensajes directos y chat social |
| Spawners de cámara y escritorio | Rooms, membresías y feeds de Tomo |
| Docker runtime y estado técnico | PostgreSQL de la red social |

Una plataforma, incluida Tomo, es un cliente del control plane. La plataforma conserva usuarios, permisos y experiencia de producto; el control plane sólo recibe un `x-api-key`, crea el runtime y devuelve una conexión temporal.

## Desarrollo

```bash
npm install
npm test
npm run build
```

Variables mínimas:

```bash
PORT=8090
TOMO_STREAM_API_KEY=replace-with-at-least-24-random-characters
AV_STREAM_SERVER_IMAGE=tomo-av-stream-server:local
STREAM_SERVER_SIGNALING_URL=ws://localhost:8090/signaling
MAX_STREAM_SESSIONS=4
TOMO_STREAM_INSTANCE_ID=my-worker
```

Fuentes del worker Linux:

- `CAMERA_DEVICE_HOST=/dev/video0`
- `X11_SOCKET_HOST=/tmp/.X11-unix`
- `PULSE_SOCKET_HOST=/run/user/1000/pulse`
- `INPUT_SOCKET_HOST_DIR=/srv/tomo/input`

## API

`GET /api/v1/stream-servers` es público. Las demás rutas requieren `x-api-key`:

- `GET|POST /api/v1/streams`
- `GET|DELETE /api/v1/streams/:id`
- `POST /api/v1/streams/:id/actions`

```json
{
  "type": "desktop-stream-server",
  "name": "Remote workspace",
  "config": {
    "display": ":0",
    "width": 1280,
    "height": 720,
    "fps": 30,
    "captureAudio": true
  }
}
```

La respuesta contiene el token del jugador. El token del host sólo se entrega al contenedor correspondiente.

## Estado

Esta versión usa Docker local y un registro de sesiones en memoria. Antes de operación multi-worker se debe sustituir por leases persistentes en Redis/PostgreSQL y un scheduler de workers. El contrato HTTP y WebRTC no cambia.

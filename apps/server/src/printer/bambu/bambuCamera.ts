// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Raw TLS socket for Bambu's camera stream; Effect has no TLS socket module.
/**
 * Reads one JPEG frame from a P1 or A1 printer's camera on TCP 6000.
 *
 * After TLS, the client sends an 80-byte login: four little-endian words (0x40, 0x3000, 0, 0),
 * then "bblp" and the access code, each padded to 32 bytes. The printer then sends frames, each a
 * 16-byte header whose first word is the JPEG size, followed by the JPEG itself.
 */
import * as NodeTls from "node:tls";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function bambuCameraLoginPacket(accessCode: string): Buffer {
  const packet = Buffer.alloc(80);
  packet.writeUInt32LE(0x40, 0);
  packet.writeUInt32LE(0x3000, 4);
  packet.write("bblp", 16, 32, "ascii");
  packet.write(accessCode, 48, 32, "ascii");
  return packet;
}

export function fetchBambuCameraFrame(options: {
  readonly address: string;
  readonly accessCode: string;
  readonly ca: ReadonlyArray<string>;
  readonly port?: number;
  readonly timeoutMs?: number;
}): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let frameSize: number | null = null;
    const socket = NodeTls.connect({
      host: options.address,
      port: options.port ?? 6000,
      ca: [...options.ca],
      checkServerIdentity: () => undefined,
    });
    const finish = (error: Error | null, frame?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(frame!);
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for a camera frame from the printer.")),
      options.timeoutMs ?? 8_000,
    );
    socket.once("secureConnect", () => socket.write(bambuCameraLoginPacket(options.accessCode)));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (frameSize === null && buffer.length >= 16) {
        frameSize = buffer.readUInt32LE(0);
        buffer = buffer.subarray(16);
        if (frameSize <= 0 || frameSize > MAX_FRAME_BYTES) {
          finish(new Error("The printer sent an invalid camera frame size."));
          return;
        }
      }
      if (frameSize !== null && buffer.length >= frameSize) {
        const frame = buffer.subarray(0, frameSize);
        const startsJpeg = frame[0] === 0xff && frame[1] === 0xd8;
        const endsJpeg = frame[frame.length - 2] === 0xff && frame[frame.length - 1] === 0xd9;
        if (!startsJpeg || !endsJpeg) {
          finish(new Error("The printer sent a camera frame that is not a JPEG."));
          return;
        }
        finish(null, new Uint8Array(frame));
      }
    });
    socket.on("error", (error: Error) => finish(error));
    socket.on("close", () =>
      finish(
        new Error(
          "The printer closed the camera connection. Check the access code, or that LAN mode liveview is enabled.",
        ),
      ),
    );
  });
}

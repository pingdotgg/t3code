// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off - A long-lived MQTT socket over Node TLS outside Effect; errors never enter an Effect failure channel directly.
/**
 * Just enough MQTT 3.1.1 to talk to a Bambu Lab printer: connect with a username and password,
 * subscribe to one topic, publish QoS 0 messages and keep the connection alive. Bambu printers
 * run their own broker on port 8883 and only ever exchange QoS 0 JSON messages with a client.
 */
import * as NodeTls from "node:tls";

const PACKET_CONNECT = 0x10;
const PACKET_CONNACK = 0x20;
const PACKET_PUBLISH = 0x30;
const PACKET_SUBSCRIBE = 0x82;
const PACKET_SUBACK = 0x90;
const PACKET_PINGREQ = 0xc0;
const PACKET_PINGRESP = 0xd0;
const PACKET_DISCONNECT = 0xe0;

const MAX_PACKET_BYTES = 8 * 1024 * 1024;

export interface MqttTlsOptions {
  /** Address to dial. Already resolved and checked by the printer URL guard. */
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly clientId: string;
  /** Certificate authorities trusted for the printer's TLS certificate (PEM). */
  readonly ca: ReadonlyArray<string>;
  readonly keepAliveSeconds?: number;
  readonly connectTimeoutMs?: number;
}

export interface MqttTlsHandlers {
  readonly onMessage: (topic: string, payload: Buffer) => void;
  readonly onClose: (error: Error | null) => void;
}

/** Thrown when the broker refuses the connection; `code` is the MQTT CONNACK return code. */
export class MqttConnectRefusedError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(
      code === 4 || code === 5
        ? "The printer rejected the access code. Check it on the printer's network settings screen."
        : `The printer refused the MQTT connection (code ${code}).`,
    );
    this.name = "MqttConnectRefusedError";
    this.code = code;
  }
}

function encodeRemainingLength(length: number): Buffer {
  const bytes: number[] = [];
  let value = length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function encodeString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function packet(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), encodeRemainingLength(body.length), body]);
}

export function encodeConnect(options: {
  readonly clientId: string;
  readonly username: string;
  readonly password: string;
  readonly keepAliveSeconds: number;
}): Buffer {
  const keepAlive = Buffer.alloc(2);
  keepAlive.writeUInt16BE(options.keepAliveSeconds, 0);
  // Protocol "MQTT" level 4, flags: username + password + clean session.
  const variableHeader = Buffer.concat([
    encodeString("MQTT"),
    Buffer.from([0x04, 0xc2]),
    keepAlive,
  ]);
  const payload = Buffer.concat([
    encodeString(options.clientId),
    encodeString(options.username),
    encodeString(options.password),
  ]);
  return packet(PACKET_CONNECT, Buffer.concat([variableHeader, payload]));
}

export function encodePublish(topic: string, payload: string): Buffer {
  return packet(PACKET_PUBLISH, Buffer.concat([encodeString(topic), Buffer.from(payload, "utf8")]));
}

export function encodeSubscribe(packetId: number, topic: string): Buffer {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId, 0);
  return packet(PACKET_SUBSCRIBE, Buffer.concat([id, encodeString(topic), Buffer.from([0x00])]));
}

export interface DecodedPacket {
  readonly type: number;
  readonly flags: number;
  readonly body: Buffer;
}

/** Splits a byte stream into MQTT packets, returning complete packets and the unread remainder. */
export function decodePackets(buffer: Buffer): {
  readonly packets: ReadonlyArray<DecodedPacket>;
  readonly rest: Buffer;
} {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const first = buffer[offset]!;
    let multiplier = 1;
    let length = 0;
    let cursor = offset + 1;
    let complete = false;
    for (let i = 0; i < 4 && cursor < buffer.length; i += 1) {
      const byte = buffer[cursor]!;
      cursor += 1;
      length += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if ((byte & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (length > MAX_PACKET_BYTES) throw new Error("MQTT packet exceeds the size limit.");
    if (cursor + length > buffer.length) break;
    packets.push({
      type: first & 0xf0,
      flags: first & 0x0f,
      body: buffer.subarray(cursor, cursor + length),
    });
    offset = cursor + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export function decodePublish(
  packetFlags: number,
  body: Buffer,
): {
  readonly topic: string;
  readonly payload: Buffer;
} {
  const topicLength = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + topicLength).toString("utf8");
  const qos = (packetFlags >> 1) & 0x03;
  const payloadStart = 2 + topicLength + (qos > 0 ? 2 : 0);
  return { topic, payload: body.subarray(payloadStart) };
}

export class MqttTlsConnection {
  readonly #socket: NodeTls.TLSSocket;
  readonly #handlers: MqttTlsHandlers;
  #buffer: Buffer = Buffer.alloc(0);
  #nextPacketId = 1;
  #closed = false;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #lastReceivedMs = Date.now();

  private constructor(socket: NodeTls.TLSSocket, handlers: MqttTlsHandlers) {
    this.#socket = socket;
    this.#handlers = handlers;
  }

  /** Opens the TLS socket, sends CONNECT and resolves once the broker accepts. */
  static connect(options: MqttTlsOptions, handlers: MqttTlsHandlers): Promise<MqttTlsConnection> {
    const keepAliveSeconds = options.keepAliveSeconds ?? 30;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = NodeTls.connect({
        host: options.host,
        port: options.port,
        ca: [...options.ca],
        // Printer certificates name the printer's serial, not its LAN address, so the chain is
        // verified against Bambu's authorities without matching the hostname.
        checkServerIdentity: () => undefined,
      });
      const connection = new MqttTlsConnection(socket, handlers);
      const timeout = setTimeout(() => {
        fail(new Error(`Timed out connecting to the printer at ${options.host}:${options.port}.`));
      }, options.connectTimeoutMs ?? 8_000);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        connection.#closed = true;
        socket.destroy();
        reject(error);
      };

      socket.once("secureConnect", () => {
        socket.write(
          encodeConnect({
            clientId: options.clientId,
            username: options.username,
            password: options.password,
            keepAliveSeconds,
          }),
        );
      });
      socket.on("data", (chunk: Buffer) => {
        connection.#lastReceivedMs = Date.now();
        connection.#buffer = Buffer.concat([connection.#buffer, chunk]);
        let decoded: ReturnType<typeof decodePackets>;
        try {
          decoded = decodePackets(connection.#buffer);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (!settled) fail(failure);
          else connection.#shutdown(failure);
          return;
        }
        connection.#buffer = Buffer.from(decoded.rest);
        for (const next of decoded.packets) {
          if (next.type === PACKET_CONNACK) {
            const code = next.body[1] ?? 255;
            if (code !== 0) {
              fail(new MqttConnectRefusedError(code));
              return;
            }
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              connection.#startKeepAlive(keepAliveSeconds);
              resolve(connection);
            }
          } else if (next.type === PACKET_PUBLISH) {
            try {
              const message = decodePublish(next.flags, next.body);
              handlers.onMessage(message.topic, message.payload);
            } catch {
              // Ignore a malformed message rather than dropping the connection.
            }
          } else if (next.type === PACKET_SUBACK || next.type === PACKET_PINGRESP) {
            // Nothing to do; receiving it already refreshed the liveness timestamp.
          }
        }
      });
      socket.on("error", (error: Error) => {
        if (!settled) fail(error);
        else connection.#shutdown(error);
      });
      socket.on("close", () => {
        if (!settled) fail(new Error("The printer closed the connection."));
        else connection.#shutdown(null);
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  subscribe(topic: string): void {
    const packetId = this.#nextPacketId;
    this.#nextPacketId = (this.#nextPacketId % 0xffff) + 1;
    this.#write(encodeSubscribe(packetId, topic));
  }

  publish(topic: string, payload: string): void {
    this.#write(encodePublish(topic, payload));
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#socket.write(Buffer.from([PACKET_DISCONNECT, 0x00]));
    } catch {
      // The socket may already be gone.
    }
    this.#shutdown(null);
  }

  #write(bytes: Buffer): void {
    if (this.#closed) throw new Error("The printer connection is closed.");
    this.#socket.write(bytes);
  }

  #startKeepAlive(keepAliveSeconds: number): void {
    const intervalMs = Math.max(5, Math.floor(keepAliveSeconds / 2)) * 1000;
    this.#pingTimer = setInterval(() => {
      if (Date.now() - this.#lastReceivedMs > keepAliveSeconds * 1500) {
        this.#shutdown(new Error("The printer stopped responding."));
        return;
      }
      try {
        this.#socket.write(Buffer.from([PACKET_PINGREQ, 0x00]));
      } catch {
        this.#shutdown(new Error("The printer connection dropped."));
      }
    }, intervalMs);
    this.#pingTimer.unref?.();
  }

  #shutdown(error: Error | null): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#socket.destroy();
    if (!wasClosed) this.#handlers.onClose(error);
  }
}

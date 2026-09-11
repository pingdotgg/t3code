import * as NodeCrypto from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

const PROTOCOL = "t3-mcp-shared-v1";
const AUTH_TIMEOUT_MS = 5_000;

function proof(token: string, role: string, nonce: string, configuration: string): string {
  return NodeCrypto.createHmac("sha256", token)
    .update(`${PROTOCOL}:${role}:${nonce}:${configuration}`)
    .digest("hex");
}

function matches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const bytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return bytes.length === expectedBytes.length && NodeCrypto.timingSafeEqual(bytes, expectedBytes);
}

function socketTransport(socket: WebSocket): Transport {
  const transport: Transport = {
    start: async () => {
      socket.on("message", (raw) => {
        try {
          transport.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(raw.toString())));
        } catch {
          transport.onerror?.(new Error("Invalid MCP message from the shared gateway."));
          socket.close(1008, "Invalid MCP message.");
        }
      });
    },
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error("Shared MCP gateway disconnected. Reconnect before sending more work."));
          return;
        }
        socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()));
      }),
    close: async () => {
      socket.terminate();
    },
  };
  socket.on("error", (error) => transport.onerror?.(error));
  socket.once("close", () => transport.onclose?.());
  return transport;
}

/** MCP authentication cannot replace or configure the desktop runtime connection. */
export async function acceptMcpSession(
  socket: WebSocket,
  token: string,
  configuration: string,
  attach: (transport: Transport) => Promise<void>,
): Promise<void> {
  const nonce = NodeCrypto.randomBytes(32).toString("hex");
  await new Promise<void>((resolve, reject) => {
    const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
    const cleanup = () => {
      timeout.removeEventListener("abort", fail);
      socket.off("message", authenticate);
      socket.off("close", fail);
      socket.off("error", fail);
    };
    const fail = () => {
      cleanup();
      socket.close(1008, "Shared gateway authentication failed.");
      reject(new Error("Shared gateway authentication failed."));
    };
    const authenticate = (raw: WebSocket.RawData) => {
      try {
        const message: unknown = JSON.parse(raw.toString());
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          message.type !== "authenticate" ||
          !("proof" in message) ||
          !matches(message.proof, proof(token, "client", nonce, configuration))
        ) {
          fail();
          return;
        }
        cleanup();
        resolve();
      } catch {
        fail();
      }
    };
    timeout.addEventListener("abort", fail, { once: true });
    socket.on("error", fail);
    socket.once("close", fail);
    socket.on("message", authenticate);
    socket.send(JSON.stringify({ type: "challenge", protocol: PROTOCOL, nonce, configuration }));
  });
  if (socket.readyState !== WebSocket.OPEN) throw new Error("MCP session closed during startup.");
  await attach(socketTransport(socket));
  socket.send(
    JSON.stringify({ type: "ready", proof: proof(token, "server", nonce, configuration) }),
  );
}

export class GatewayUnavailableError extends Error {}

/** An occupied port is usable only if its owner proves the same token and configuration. */
export function connectMcpSession(input: {
  readonly port: number;
  readonly token: string;
  readonly configuration: string;
}): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${input.port}/mcp`, { maxPayload: 1024 * 1024 });
    let nonce: string | undefined;
    const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
    const onTimeout = () => fail(new Error("Timed out authenticating the shared MCP gateway."));
    const cleanup = () => {
      timeout.removeEventListener("abort", onTimeout);
      socket.off("message", authenticate);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      // Terminating an incomplete WebSocket upgrade can emit another error.
      socket.on("error", () => undefined);
      socket.terminate();
      reject(error);
    };
    const onError = (error: NodeJS.ErrnoException) =>
      fail(
        error.code === "ECONNREFUSED"
          ? new GatewayUnavailableError("No shared gateway is listening.")
          : error,
      );
    const onClose = () =>
      fail(
        new Error(
          "Gateway authentication failed or the port belongs to an older gateway. Stop the old gateway and reconnect.",
        ),
      );
    const authenticate = (raw: WebSocket.RawData) => {
      try {
        const value: unknown = JSON.parse(raw.toString());
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("Invalid handshake.");
        }
        const message = value as Record<string, unknown>;
        if (nonce === undefined) {
          if (
            message.type !== "challenge" ||
            message.protocol !== PROTOCOL ||
            typeof message.nonce !== "string" ||
            message.configuration !== input.configuration
          ) {
            fail(
              new Error(
                "The bridge port belongs to an incompatible gateway or different configuration. Stop that gateway or use a separate bridge port and state file.",
              ),
            );
            return;
          }
          nonce = message.nonce;
          socket.send(
            JSON.stringify({
              type: "authenticate",
              proof: proof(input.token, "client", nonce, input.configuration),
            }),
          );
          return;
        }
        if (
          message.type !== "ready" ||
          !matches(message.proof, proof(input.token, "server", nonce, input.configuration))
        ) {
          fail(new Error("Shared gateway server authentication failed."));
          return;
        }
        cleanup();
        resolve(socketTransport(socket));
      } catch {
        fail(new Error("Invalid shared gateway authentication response."));
      }
    };
    timeout.addEventListener("abort", onTimeout, { once: true });
    socket.on("error", onError);
    socket.once("close", onClose);
    socket.on("message", authenticate);
  });
}

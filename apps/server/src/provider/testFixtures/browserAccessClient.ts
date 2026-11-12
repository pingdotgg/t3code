// @effect-diagnostics nodeBuiltinImport:off -- Speaks the browser plugin's native pipe framing in tests.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";

const header = (length: number) => {
  const bytes = Buffer.alloc(4);
  if (NodeOS.endianness() === "LE") bytes.writeUInt32LE(length);
  else bytes.writeUInt32BE(length);
  return bytes;
};

/**
 * Asks the host like the browser plugin does and returns its decision, after checking the
 * signature against the published identity. Undefined when the host hangs up.
 */
export const requestBrowserAccess = (
  environment: NodeJS.ProcessEnv,
  request: { readonly sessionId: string; readonly turnId: string; readonly executorId?: string },
) => {
  const params = {
    executorId: request.executorId ?? environment.BROWSER_USE_ACCESS_EXECUTOR_ID,
    sessionId: request.sessionId,
    turnId: request.turnId,
    nonce: "a".repeat(64),
  };
  const body = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", method: "browser/access", params, id: 1 }),
  );
  return Effect.promise(
    () =>
      new Promise<
        | {
            readonly jsonrpc: unknown;
            readonly id: unknown;
            readonly result: { readonly payload: string; readonly signature: string };
          }
        | undefined
      >((resolve) => {
        const frame = Buffer.concat([header(body.length), body]);
        const socket = NodeNet.createConnection(
          environment.BROWSER_USE_ACCESS_PIPE_PATH ?? "",
          () => {
            // Split the length prefix so the host must reassemble partial frames.
            socket.write(frame.subarray(0, 3));
            socket.write(frame.subarray(3));
          },
        );
        let bytes = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, chunk]);
        });
        socket.on("error", () => resolve(undefined));
        socket.on("close", () => {
          if (bytes.length < 4) return resolve(undefined);
          const size = NodeOS.endianness() === "LE" ? bytes.readUInt32LE() : bytes.readUInt32BE();
          resolve(JSON.parse(bytes.subarray(4, 4 + size).toString("utf8")));
        });
      }),
  ).pipe(
    Effect.map((envelope) => {
      if (envelope === undefined) return undefined;
      if (envelope.jsonrpc !== "2.0" || envelope.id !== 1)
        throw new Error("Browser access reply does not answer the request");
      const response = envelope.result;
      const key = NodeCrypto.createPublicKey({
        key: Buffer.from(environment.BROWSER_USE_ACCESS_VERIFYING_IDENTITY ?? "", "base64"),
        type: "spki",
        format: "der",
      });
      const signed = NodeCrypto.verify(
        null,
        Buffer.from(response.payload),
        key,
        Buffer.from(response.signature, "base64"),
      );
      const decision = JSON.parse(response.payload);
      if (
        !signed ||
        decision.domain !== "codex.browserAccess.v1" ||
        JSON.stringify(decision.request) !== JSON.stringify(params)
      )
        throw new Error("Browser access decision failed verification");
      return decision.allowed as boolean;
    }),
  );
};

// @effect-diagnostics nodeBuiltinImport:off - Private local IPC framing, shared by server and lean CLI.
import type * as NodeNet from "node:net";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const Request = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: ProviderInstanceId,
  environmentId: EnvironmentId,
  profileKey: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const Response = Schema.Struct({ token: Schema.NonEmptyString });
// A request contains only a slug, UUID and SHA-256 binding. Tokens can be larger
// JWTs. Never truncate either frame into something that could be accepted.
export const REQUEST_BYTES = 1024;
export const RESPONSE_BYTES = 64 * 1024;
// Idle/incomplete peers and blocked response consumers must not retain sockets.
export const SOCKET_IDLE_MS = 5_000;
// Existing lock retry (40s), OAuth (20s), plus startup/store headroom (20s).
export const COMMAND_TIMEOUT_MS = 80_000;
export class ProtocolError extends Schema.TaggedError<ProtocolError>()(
  "ManagedTokenProtocolError",
  {},
) {}

export const readFrame = (socket: NodeNet.Socket, maxBytes: number, timeoutMs: number) =>
  Effect.callback<string, ProtocolError>((resume) => {
    let bytes = Buffer.alloc(0);
    const fail = () => resume(Effect.fail(new ProtocolError()));
    const onData = (chunk: Buffer) => {
      if (bytes.length + chunk.length > maxBytes) return fail();
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf(10);
      if (end < 0) return;
      if (end !== bytes.length - 1) return fail();
      resume(Effect.succeed(bytes.subarray(0, end).toString("utf8")));
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("end", fail);
    return Effect.sync(() => {
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", fail);
      socket.off("end", fail);
    });
  }).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new ProtocolError()) }),
  );

export const writeFrame = (socket: NodeNet.Socket, frame: string, maxBytes: number) =>
  Effect.callback<void, ProtocolError>((resume) => {
    if (socket.destroyed || Buffer.byteLength(frame) + 1 > maxBytes) {
      resume(Effect.fail(new ProtocolError()));
      return;
    }
    const fail = () => resume(Effect.fail(new ProtocolError()));
    socket.once("error", fail);
    socket.once("close", fail);
    socket.end(`${frame}\n`, () => resume(Effect.void));
    return Effect.sync(() => {
      socket.off("error", fail);
      socket.off("close", fail);
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: SOCKET_IDLE_MS,
      orElse: () => Effect.fail(new ProtocolError()),
    }),
  );

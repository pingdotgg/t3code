// @effect-diagnostics nodeBuiltinImport:off - Lean self-invoked local IPC client; no auth/store graph.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Protocol from "../provider/CodexManagedTokenProtocol.ts";

const decodeArguments = Schema.decodeUnknownEffect(
  Schema.Tuple([
    Schema.NonEmptyString,
    Protocol.Request.fields.instanceId,
    Protocol.Request.fields.environmentId,
    Protocol.Request.fields.profileKey,
  ]),
);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Protocol.Request));
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Protocol.Response), {
  onExcessProperty: "error",
});

/** Codex's auth.command protocol is a bare token on stdout, never a CLI diagnostic. */
export async function runManagedChatGptTokenCli(args: ReadonlyArray<string>): Promise<void> {
  const program = Effect.gen(function* () {
    const [endpoint, instanceId, environmentId, profileKey] = yield* decodeArguments(args);
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => NodeNet.createConnection(endpoint)),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    socket.on("error", () => {});
    socket.once("connect", () =>
      socket.write(encodeRequest({ version: 1, instanceId, environmentId, profileKey }) + "\n"),
    );
    return yield* Protocol.readFrame(
      socket,
      Protocol.RESPONSE_BYTES,
      Protocol.COMMAND_TIMEOUT_MS,
    ).pipe(Effect.flatMap(decodeResponse));
  }).pipe(Effect.scoped);
  const result = await Effect.runPromiseExit(program);
  if (Exit.isFailure(result)) {
    process.stderr.write(
      "Could not access the managed ChatGPT connection. Reconnect in T3 Code.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.value.token);
}

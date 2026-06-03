import * as Cloudflare from "@/Cloudflare";
import { Stack } from "@/Stack";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

export class Sandbox extends Cloudflare.Container<
  Sandbox,
  {
    getUser: () => Effect.Effect<{ id: string; name: string }>;
  }
>()(
  "Sandbox",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    // handler: "SandboxLive",
    instanceType: stack.stage === "prod" ? "standard-1" : "dev",
    dockerfile: `FROM alpine:latest`,
  })),
) {}

export const SandboxLive = Sandbox.make(
  Effect.gen(function* () {
    // bind dependencies
    // yield* Cloudflare.Queue()

    // return http effect
    return {
      getUser: () => Effect.succeed({ id: "123", name: "John Doe" } as const),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // upgrade to web socket
        const socket = yield* request.upgrade;
        const writeMessage = yield* socket.writer;
        const cmd = yield* ChildProcess.make("ffmpeg", ["-version"]);
        const [exitCode] = yield* Effect.all(
          [
            cmd.exitCode,
            // pipe stdout to the websocket
            cmd.stdout.pipe(
              Stream.tap(writeMessage),
              Stream.decodeText,
              Stream.mkString,
            ),
          ] as const,
          { concurrency: "unbounded" },
        );

        return HttpServerResponse.empty({
          status: exitCode === 0 ? 200 : 500,
        });
      }).pipe(Effect.orDie),
    };
  }),
);

export default SandboxLive;

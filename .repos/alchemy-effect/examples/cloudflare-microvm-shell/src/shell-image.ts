import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/**
 * The trailer the in-VM server appends after a command's output so the
 * Durable Object can learn the exit code without it leaking into the
 * terminal: `\n__EXIT__:<code>\n`.
 */
const EXIT_MARKER = "__EXIT__:";

const encoder = new TextEncoder();

/**
 * The build role is created bare; the image grants it the trust + build
 * permissions it needs through a binding.
 */
export const ShellBuildRole = AWS.IAM.Role("ShellMicrovmBuildRole");

/**
 * The shell MicroVM image — an **effectful** image: this module is both the
 * image declaration and the in-VM server. The Effect program below is
 * bundled into the image (bun runtime) and served by the alchemy MicroVM
 * bootstrap; there is no Dockerfile and no hand-rolled HTTP server.
 *
 * `POST /exec { "command": "<sh command>" }` → a chunked text/plain response
 * streaming the command's interleaved stdout+stderr as it is produced,
 * terminated by the `__EXIT__` trailer. The MicroVM auth token is enforced
 * by the endpoint proxy in front of this server, so the server itself
 * trusts every request it receives.
 */
export class ShellMicrovm extends AWS.Lambda.MicrovmImage<ShellMicrovm>()(
  "ShellMicrovm",
) {}

export default ShellMicrovm.make(
  ShellBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      buildRole,
      runtime: "bun" as const,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");

        if (url.pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/exec") {
          const body = (yield* request.json.pipe(
            Effect.orElseSucceed(() => undefined),
          )) as { command?: unknown } | undefined;
          const command =
            typeof body?.command === "string" ? body.command : "";
          if (!command.trim()) {
            return HttpServerResponse.text("empty command", { status: 400 });
          }

          const spawner = yield* ChildProcessSpawner;
          // The spawned handle is scoped; `Stream.unwrap` folds that scope
          // into the stream's lifetime, so the process is reaped exactly when
          // the response stream completes (or the client goes away).
          const output = Stream.unwrap(
            spawner
              .spawn(ChildProcess.make("sh", ["-c", command], { shell: false }))
              .pipe(
                Effect.map((handle) =>
                  Stream.merge(handle.stdout, handle.stderr).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        handle.exitCode.pipe(
                          Effect.map((code) =>
                            encoder.encode(`\n${EXIT_MARKER}${code}\n`),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ).pipe(
            // Spawn/pipe failures still terminate the protocol: report them
            // as a non-zero exit with the error as output.
            Stream.catchCause((cause) =>
              Stream.make(
                encoder.encode(`\n${EXIT_MARKER}1\n${String(cause)}\n`),
              ),
            ),
          );

          return HttpServerResponse.stream(output, {
            contentType: "text/plain; charset=utf-8",
            headers: { "cache-control": "no-store" },
          });
        }

        return HttpServerResponse.text("shell microvm: POST /exec", {
          status: 404,
        });
      }),
    };
  }),
);

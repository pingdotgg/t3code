import { describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

// Covers patches/@effect__platform-node-shared@4.0.1.patch. A stopped child
// never reads its input, so a chunk larger than the socket buffer leaves a
// write queued. Closing the scope interrupts the writer and kills the child,
// and the pipe then fails with EPIPE (stdin) or ECONNRESET (extra fds, which
// Node also reads). Unpatched, nothing listens by then and the uncaught error
// kills the server, as HtmlRender's Chrome pipe did on every torn-down capture.
const killChildWithQueuedInput = (target: "stdin" | "fd3") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "process.kill(process.pid, 'SIGSTOP')"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "100 millis",
            additionalFds: { fd3: { type: "input" } },
          }),
        );
        const pulled = yield* Deferred.make<void>();
        const input = Stream.make(new Uint8Array(4 * 1024 * 1024)).pipe(
          Stream.tap(() => Deferred.succeed(pulled, undefined)),
        );
        yield* Effect.forkScoped(
          Stream.run(input, target === "stdin" ? child.stdin : child.getInputFd(3)),
        );
        yield* Deferred.await(pulled);
      }),
    );
    // The scope ends once the killed child is reaped. Its pipe failure is
    // already queued by then and lands in this same poll phase.
    yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
  }).pipe(Effect.provide(NodeServices.layer));

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("child process input pipes", () => {
  it.live("survive a child killed with stdin still queued", () =>
    killChildWithQueuedInput("stdin"),
  );

  it.live("survive a child killed with additional fd input still queued", () =>
    killChildWithQueuedInput("fd3"),
  );
});

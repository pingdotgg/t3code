import * as Cloudflare from "@alchemy.run/cloudflare";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { NativeImages } from "./images.ts";

/** The Durable Object's first image. */
export class NativeShell extends Cloudflare.Container<NativeShell>()(
  "NativeShell",
  Effect.map(NativeImages, ({ shell }) => ({
    schedulingPolicy: "durable_object" as const,
    image: shell,
  })),
) {}

/** The Durable Object's second image; without one, the class has only Shell's. */
export class NativeTools extends Cloudflare.Container<NativeTools>()(
  "NativeTools",
  Effect.map(NativeImages, ({ tools }) => ({
    schedulingPolicy: "durable_object" as const,
    image: tools,
  })),
) {}

/** The reviewer's own image; NativeShell is shared by both classes. */
export class NativeLint extends Cloudflare.Container<NativeLint>()("NativeLint", {
  schedulingPolicy: "durable_object",
  image: "alpine:3.19",
}) {}

/** Route names for the two images. */
export type ImageName = "shell" | "tools";

const SLEEP_FOREVER = ["sleep", "infinity"];
const SEED_FILE = ["sh", "-c", "printf writable > /redeploy-marker"];
const READ_RELEASE_AND_SEED = [
  "sh",
  "-c",
  "cat /etc/alpine-release; cat /redeploy-marker 2>/dev/null || true",
];

const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

/** Only the registered interception answers this host (see worker.ts). */
export const INTERCEPT_HOST = "intercept.internal";

/** `ctx.exports` entrypoints; workers-types does not type them on DurableObjectState. */
interface InterceptExports {
  default(options: { props: Record<string, never> }): cf.Fetcher;
}

export class NativeObject extends Cloudflare.DurableObject<NativeObject>()(
  "NativeObject",
  Effect.gen(function* () {
    // Both Containers share this object's one container instance; each
    // handle's start() starts its own image.
    const handles = { shell: yield* NativeShell, tools: yield* NativeTools };
    const container = handles.shell;
    const state = yield* DurableObjectState;
    /** The image map Cloudflare exposes to this object, keyed by Container id. */
    const imageMap = Effect.sync(() => state.container?.images ?? {});
    /** Changes whenever the runtime re-creates this object. */
    let incarnation: string | undefined;

    const storedMarker = Effect.map(
      state.storage.get<string>("marker"),
      (marker) => marker ?? null,
    );

    /** Run a command in the started container and collect its output. */
    const run = (cmd: string[]) =>
      Effect.scoped(Effect.flatMap(container.exec(cmd), (child) => child.output()));

    const startImage = Effect.fn(function* (name: ImageName) {
      yield* handles[name].start({ entrypoint: SLEEP_FOREVER, enableInternet: false });
    });

    /** Snapshot a file, prove a fresh start lacks it, then restore it. */
    const snapshotRoundTrip = Effect.gen(function* () {
      yield* run(["sh", "-c", "printf persisted > /workspace-file"]);
      const snapshot = yield* container.snapshotContainer();
      yield* container.destroy();

      yield* startImage("shell");
      const fresh = yield* run(["test", "!", "-e", "/workspace-file"]);
      if (fresh.exitCode !== 0) {
        return yield* Effect.die("Fresh container retained snapshot file");
      }
      yield* container.destroy();

      yield* container.start({
        containerSnapshot: snapshot,
        entrypoint: SLEEP_FOREVER,
        enableInternet: false,
      });
      return yield* run(["cat", "/workspace-file"]);
    });

    /** Pipe "native stdin" through `cat` while collecting its output. */
    const stdinRoundTrip = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* container.exec(["cat"], { stdin: "pipe" });
        const writeStdin = Stream.make(new TextEncoder().encode("native stdin")).pipe(
          Stream.run(child.stdin!),
        );
        const [, output] = yield* Effect.all([writeStdin, child.output()], {
          concurrency: "unbounded",
        });
        return output;
      }),
    );

    const ensureShell = Effect.gen(function* () {
      if (!(yield* container.running)) yield* startImage("shell");
    });

    /** Process lifecycle against the real runtime (workerd + Docker or Cloudflare). */
    const lifecycle = Effect.fn(function* (mode: "interrupt" | "stream" | "monitor" | "intercept") {
      if (mode === "intercept") {
        // Started without internet: only this object's interception can answer.
        yield* ensureShell;
        // Cloudflare routes intercepted traffic only to a Worker entrypoint or
        // service binding, so register this Worker's default entrypoint.
        const exports = (state.raw as unknown as { exports: InterceptExports }).exports;
        const entrypoint = Cloudflare.fromCloudflareFetcher(exports.default({ props: {} }));
        yield* container.interceptOutboundHttp(INTERCEPT_HOST, entrypoint);
        const output = yield* run(["wget", "-qO-", `http://${INTERCEPT_HOST}/hello`]);
        return {
          exitCode: output.exitCode,
          stdout: decode(output.stdout),
          stderr: decode(output.stderr),
        };
      }
      if (mode === "interrupt") {
        yield* ensureShell;
        // Closing the exec scope (here via timeout) must SIGKILL the process.
        yield* Effect.scoped(
          Effect.flatMap(container.exec(["sleep", "301"]), (child) => child.exitCode),
        ).pipe(Effect.timeout("1 second"), Effect.ignore);
        // `30[1]` keeps pgrep from matching this shell's own command line.
        // Poll briefly: the kill is delivered asynchronously.
        const check = yield* run([
          "sh",
          "-c",
          "for i in 1 2 3 4 5 6; do pgrep -f 'sleep 30[1]' >/dev/null || exit 0; sleep 0.5; done; pgrep -f 'sleep 30[1]'",
        ]);
        return { remaining: decode(check.stdout).trim() };
      }
      if (mode === "stream") {
        yield* ensureShell;
        const chunks = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* container.exec(["sh", "-c", "printf a; sleep 0.2; printf b"]);
            return yield* Stream.runCollect(child.stdout!);
          }),
        );
        return { stdout: chunks.map((chunk) => new TextDecoder().decode(chunk)).join("") };
      }
      if (yield* container.running) yield* container.destroy();
      yield* container.start({
        entrypoint: ["sh", "-c", "exit 3"],
        enableInternet: false,
      });
      const result = yield* container.monitor().pipe(Effect.result);
      return Result.isFailure(result)
        ? { failed: true, tag: result.failure._tag }
        : { failed: false, tag: undefined };
    });

    return Effect.succeed({
      lifecycle,
      metadata: Effect.fn(function* () {
        incarnation ??= crypto.randomUUID();
        return {
          id: state.id.toString(),
          incarnation,
          images: yield* imageMap,
          stored: yield* storedMarker,
        };
      }),
      evict: () => state.abort("container image eviction probe", { retryAlarm: false }),
      revision: () =>
        Effect.promise(async () => {
          const { env } = await import("cloudflare:workers");
          return (env as { IMAGE_REVISION: string }).IMAGE_REVISION;
        }),
      /** Report which image is running and whether the seeded file survived. */
      probe: Effect.fn(function* (options: { seed: boolean; restart: boolean; image: ImageName }) {
        if (options.restart) yield* container.destroy();

        const wasRunning = yield* container.running;
        if (!wasRunning) yield* startImage(options.image);
        if (options.seed) {
          yield* state.storage.put("marker", "durable");
          yield* run(SEED_FILE);
        }

        const output = yield* run(READ_RELEASE_AND_SEED);
        const [release, file] = decode(output.stdout).split("\n");
        return {
          wasRunning,
          configured: yield* handles[options.image].image,
          inspected: (yield* container.inspect())?.image,
          release,
          file,
          stored: yield* storedMarker,
        };
      }),
      // The Durable Object's own RPC can be named exec; it is separate from
      // the container handle's exec.
      exec: Effect.fn(function* (
        mode: "exec" | "stdin" | "snapshot" = "exec",
        image: ImageName = "shell",
      ) {
        if (!(yield* container.running)) {
          yield* handles[image].start({
            entrypoint: SLEEP_FOREVER,
            enableInternet: false,
            instance: "lite",
          });
        }

        let output: Cloudflare.Containers.ContainerExecOutput;
        if (mode === "snapshot") {
          output = yield* snapshotRoundTrip;
        } else if (mode === "stdin") {
          output = yield* stdinRoundTrip;
        } else {
          output = yield* run(["sh", "-c", "printf native; exit 7"]);
        }
        const release = yield* run(["cat", "/etc/alpine-release"]);

        return {
          stdout: decode(output.stdout),
          exitCode: output.exitCode,
          release: decode(release.stdout).trim(),
          images: Object.keys(yield* imageMap).sort(),
        };
      }),
    });
  }),
) {}

/**
 * A second class on the same Worker. It shares `NativeShell` with
 * `NativeObject` and adds `NativeLint`, so each class has its own container
 * application and image map.
 */
export class NativeReviewer extends Cloudflare.DurableObject<NativeReviewer>()(
  "NativeReviewer",
  Effect.gen(function* () {
    const handles = { shell: yield* NativeShell, lint: yield* NativeLint };
    const state = yield* DurableObjectState;
    const run = (cmd: string[]) =>
      Effect.scoped(Effect.flatMap(handles.shell.exec(cmd), (child) => child.output()));

    return Effect.succeed({
      exec: Effect.fn(function* (image: "shell" | "lint") {
        if (!(yield* handles.shell.running)) {
          yield* handles[image].start({ entrypoint: SLEEP_FOREVER, enableInternet: false });
        }
        const output = yield* run(["sh", "-c", "printf native; exit 7"]);
        const release = yield* run(["cat", "/etc/alpine-release"]);
        return {
          stdout: decode(output.stdout),
          exitCode: output.exitCode,
          release: decode(release.stdout).trim(),
          images: Object.keys(state.container?.images ?? {}).sort(),
        };
      }),
    });
  }),
) {}

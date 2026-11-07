/**
 * Hot reload for user-supplied Dockerfile/context Cloudflare Containers
 * under `alchemy dev`.
 *
 * These files are NOT imported by the stack, so `bun --watch` never re-runs
 * the exec child for them — the reload rides two engine pieces this suite
 * pins:
 *
 *  1. the LOCAL provider's diff recomputes the image hash fresh on every
 *     plan (the RPC sidecar's ArtifactStore outlives runs, so an unevicted
 *     memo would compare the FIRST run's hash forever and report noop);
 *  2. the local worker runner fs-watches each Build-variant container's
 *     context and restarts the instance — which IS the docker rebuild —
 *     when the content fingerprint changes, with no deploy in between.
 *
 * Requires Docker; skipped when the daemon is unavailable.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import type { ReloadEchoObject } from "./fixtures/reload/async-worker.ts";
import { RELOAD_CONTAINER_PORT, RELOAD_CONTEXT_DIR } from "./fixtures/reload/container.ts";
import ReloadContainerWorker from "./fixtures/reload/worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const dockerfile = (marker: string) =>
  `FROM busybox:stable
COPY index.html /www/index.html
ENV BAKED_MARKER=${marker}
EXPOSE ${RELOAD_CONTAINER_PORT}
CMD ["sh", "-c", "echo -n \\"$BAKED_MARKER\\" > /www/baked.txt && exec httpd -f -p ${RELOAD_CONTAINER_PORT} -h /www"]
`;

/** Poll the worker's proxy route until the file body matches. */
const pollText = Effect.fn(function* (options: {
  url: string;
  path: string;
  expected: string;
  times?: number;
}) {
  const client = yield* HttpClient.HttpClient;
  const body = yield* client.get(`${options.url}${options.path}`).pipe(
    Effect.flatMap((response) => response.text),
    Effect.retry({
      while: (): boolean => true,
      schedule: Schedule.spaced("2 seconds"),
      times: options.times ?? 90,
    }),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (b): boolean => b.trim() === options.expected,
      times: options.times ?? 90,
    }),
  );
  expect(body.trim()).toBe(options.expected);
});

/**
 * Async Worker hosting a container-backed DO, with a `MARKER` env var whose
 * change restarts the Worker (a new workerd generation) WITHOUT touching the
 * container image.
 */
const reloadEnvWorker = (marker: string) =>
  Cloudflare.Worker("ReloadEnvContainerWorker", {
    main: pathe.resolve(import.meta.dirname, "fixtures/reload/async-worker.ts"),
    env: {
      ECHO: Cloudflare.Container<ReloadEchoObject>("ECHO", {
        className: "ReloadEchoObject",
        image: "mendhak/http-https-echo:latest",
      }),
      MARKER: marker,
    },
  });

/** One request into the container; fails unless the echo server answered. */
const echo = Effect.fn(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(new URL("/hello", url));
  const text = yield* response.text;
  if (response.status !== 200 || !text.includes("method")) {
    return yield* Effect.fail(
      new Error(`container request failed: ${response.status} ${text.slice(0, 500)}`),
    );
  }
  return text;
});

describe.sequential(
  "LocalContainerReload",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:container",
      "provider:cloudflare:worker",
      "local",
    ],
  },
  () => {
    test.provider(
      "context/Dockerfile edits rebuild the running container — with and without a deploy",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* stack.destroy();

          // Materialize the build context at the fixture's fixed path.
          yield* fs.makeDirectory(RELOAD_CONTEXT_DIR, { recursive: true });
          yield* fs.writeFileString(
            path.join(RELOAD_CONTEXT_DIR, "Dockerfile"),
            dockerfile("baked-v1"),
          );
          yield* fs.writeFileString(path.join(RELOAD_CONTEXT_DIR, "index.html"), "content-v1\n");

          const deploy = Effect.gen(function* () {
            const worker = yield* ReloadContainerWorker;
            return { worker };
          });

          const first = yield* stack.deploy(deploy);
          expect(first.worker.url).toMatch(/^http:\/\/localhost:\d+/);
          const url = first.worker.url!;

          // First contact builds the image and boots the container.
          yield* pollText({ url, path: "/index.html", expected: "content-v1" });
          yield* pollText({ url, path: "/baked.txt", expected: "baked-v1" });

          // ── 1. content change + REDEPLOY: the diff must see it (regression:
          // the sidecar-lifetime artifact memo made every later plan compare
          // the first run's hash and noop forever) ──
          yield* fs.writeFileString(path.join(RELOAD_CONTEXT_DIR, "index.html"), "content-v2\n");
          yield* stack.deploy(deploy);
          yield* pollText({ url, path: "/index.html", expected: "content-v2" });

          // ── 2. content change, NO deploy: the worker runner's context
          // watcher must rebuild + restart on its own ──
          yield* fs.writeFileString(path.join(RELOAD_CONTEXT_DIR, "index.html"), "content-v3\n");
          yield* pollText({ url, path: "/index.html", expected: "content-v3" });

          // ── 3. the DOCKERFILE itself, NO deploy ──
          yield* fs.writeFileString(
            path.join(RELOAD_CONTEXT_DIR, "Dockerfile"),
            dockerfile("baked-v2"),
          );
          yield* pollText({ url, path: "/baked.txt", expected: "baked-v2" });
          // The content file survived the Dockerfile rebuild.
          yield* pollText({ url, path: "/index.html", expected: "content-v3" });

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 600_000 },
    );

    // Regression: a Worker restart while its container is RUNNING. The
    // replacement workerd generation used to start while the previous one
    // (and its container) was still up, so the new generation "recovered"
    // the running container — and the previous generation's teardown then
    // removed that container (and its networking sidecar) out from under
    // it: `Recovered running container without a running networking
    // sidecar`, then `container <id> is not running` on the next request.
    test.provider(
      "a running container keeps serving across Worker restarts",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const first = yield* stack.deploy(reloadEnvWorker("v1"));
          expect(first.url).toMatch(/^http:\/\/localhost:\d+/);
          const url = first.url!;

          // First contact pulls the image and boots the container, which
          // then stays running (`sleepAfter`).
          yield* echo(url).pipe(
            Effect.timeout("30 seconds"),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
          );

          for (const marker of ["v2", "v3", "v4"]) {
            yield* stack.deploy(reloadEnvWorker(marker));
            yield* pollText({ url, path: "/marker", expected: marker, times: 15 });
            // No retries: the container must answer straight away, and keep
            // answering, from the new generation.
            for (let i = 0; i < 3; i++) {
              yield* echo(url).pipe(Effect.timeout("60 seconds"));
              yield* Effect.sleep("1 second");
            }
          }

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 600_000 },
    );
  },
);

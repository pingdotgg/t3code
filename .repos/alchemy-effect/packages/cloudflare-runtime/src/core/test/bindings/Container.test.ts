import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { execFileSync } from "node:child_process";
import * as DurableObjectNamespace from "../../bindings/DurableObjectNamespace.ts";
import type { ContainerImage } from "../../Docker.ts";
import { getFixture } from "../helpers/fixture.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const FIXTURE_DIR = getFixture("container");
const DOCKER_BIN = process.env.DOCKER_BIN ?? "docker";

// A Durable Object with an attached container. It starts the container and
// proxies the incoming request to the HTTP server listening on `port`.
const SCRIPT = (index: number, port: number) => `
import { DurableObject } from "cloudflare:workers";

export class MyContainer${index} extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container) {
      return new Response("no container binding", { status: 500 });
    }
    if (!container.running) {
      container.start();
    }
    const port = container.getTcpPort(${port});
    let lastError = "";
    for (let i = 0; i < 100; i++) {
      try {
        const res = await port.fetch("http://container/");
        if (res.ok) {
          return new Response(await res.text());
        }
        lastError = "status " + res.status;
      } catch (error) {
        lastError = String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return new Response("container not ready: " + lastError, { status: 504 });
  }
}

export default {
  async fetch(request, env) {
    const id = env.MY_CONTAINER.idFromName("singleton");
    return env.MY_CONTAINER.get(id).fetch(request);
  },
};
`;

layer(localRuntimeLayer, { excludeTestServices: true, timeout: 30_000 })(
  "Container binding",
  (it) => {
    const test = it.effect.skipIf(!isDockerAvailable());

    let i = 0;
    const nextIndex = () => i++;

    test(
      "recovers from interruptions",
      () =>
        Effect.gen(function* () {
          const fiber = yield* testContainer({
            index: nextIndex(),
            port: 8080,
            expected: "hello from container",
            container: { dockerfile: "Dockerfile", context: FIXTURE_DIR },
          }).pipe(Effect.forkDetach);
          yield* Fiber.interrupt(fiber);
          yield* testContainer({
            index: nextIndex(),
            port: 8080,
            expected: "hello from container",
            container: { dockerfile: "Dockerfile", context: FIXTURE_DIR },
          });
        }),
      { concurrent: true },
    );

    test(
      "builds a container image and proxies requests to it via ctx.container",
      () =>
        testContainer({
          index: nextIndex(),
          port: 8080,
          expected: "hello from container",
          container: { dockerfile: "Dockerfile", context: FIXTURE_DIR },
        }),
      { concurrent: true },
    );

    test(
      "proxies requests to multiple containers",
      () =>
        Effect.forEach(
          Array.from({ length: 10 }),
          () =>
            testContainer({
              index: nextIndex(),
              port: 8080,
              expected: "hello from container",
              container: {
                dockerfile: "Dockerfile",
                context: FIXTURE_DIR,
              },
            }),
          { concurrency: "unbounded" },
        ),
      { concurrent: true },
    );

    test(
      "injects configured environment variables into the container",
      () =>
        testContainer({
          index: nextIndex(),
          port: 8080,
          expected: "hello from container howdy",
          container: {
            dockerfile: "Dockerfile",
            context: FIXTURE_DIR,
            env: { CONTAINER_GREETING: "howdy" },
          },
        }),
      { concurrent: true },
    );

    test(
      "pulls an existing image by imageUri and proxies requests to it",
      () => {
        // A public image with an HTTP server that exposes a port and serves a stable
        // response, used to exercise the `imageUri` (pull) path without a Dockerfile.
        const NGINX_IMAGE = "nginx:1.27-alpine";

        return testContainer({
          index: nextIndex(),
          port: 80,
          expected: "Welcome to nginx!",
          container: { imageUri: NGINX_IMAGE },
        }).pipe(Effect.ensuring(Effect.sync(() => removeImage(NGINX_IMAGE))));
      },
      { concurrent: true },
    );
  },
);

const testContainer = Effect.fn(
  function* (options: {
    index: number;
    port: number;
    expected: string;
    container: ContainerImage;
  }) {
    const worker = yield* startTestWorker({
      name: `container-binding-${options.index}`,
      compatibilityDate: "2026-03-17",
      compatibilityFlags: [],
      bindings: [
        DurableObjectNamespace.local({
          binding: "MY_CONTAINER",
          className: `MyContainer${options.index}`,
        }),
      ],
      modules: [
        {
          name: "main.js",
          type: "ESModule",
          content: SCRIPT(options.index, options.port),
        },
      ],
      durableObjectNamespaces: [
        {
          className: `MyContainer${options.index}`,
          sql: true,
          container: options.container,
        },
      ],
    });

    const text = yield* worker.fetchText("/");
    expect(text).toContain(options.expected);
  },
  (self, options) =>
    self.pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() =>
          removeImage(`alchemy-dev/mycontainer${options.index}`),
        ),
      ),
    ),
);

const removeImage = (reference: string) => {
  try {
    const output = execFileSync(
      DOCKER_BIN,
      [
        "images",
        "--format",
        "{{.Repository}}:{{.Tag}}",
        "--filter",
        `reference=${reference}`,
      ],
      {
        stdio: "pipe",
        encoding: "utf-8",
      },
    );
    const images = output
      .split("\n")
      .map((image) => image.trim())
      .filter(Boolean);
    if (images.length > 0) {
      execFileSync(DOCKER_BIN, ["rmi", ...images], {
        stdio: "ignore",
      });
    }
  } catch {
    // ignore errors - best effort
  }
};

const isDockerAvailable = () => {
  // Containers are not supported on Windows: the Docker daemon there runs
  // Windows containers and cannot pull the `linux/amd64` images these tests
  // depend on. This mirrors upstream workers-sdk, which bails out on Windows.
  if (process.platform === "win32") {
    return false;
  }
  try {
    execFileSync(DOCKER_BIN, ["info"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

import { existsSync } from "node:fs";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as DurableObjectNamespace from "../../bindings/DurableObjectNamespace.ts";
import type { ContainerImage } from "../../Docker.ts";
import { docker } from "../helpers/docker.ts";
import { getFixture } from "../helpers/fixture.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const FIXTURE_DIR = getFixture("container");

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
    let i = 0;
    const nextIndex = () => i++;

    it.effect(
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

    it.effect(
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

    it.effect(
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

    it.effect(
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

    it.effect(
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
        }).pipe(Effect.ensuring(removeImage(NGINX_IMAGE)));
      },
      { concurrent: true },
    );
  },
);

// Starts the container (from its named image when it has one) and returns
// what the fixture reports about its privileges.
const FUSE_SCRIPT = `
import { DurableObject } from "cloudflare:workers";

class FuseContainer extends DurableObject {
  async fetch() {
    const container = this.ctx.container;
    if (!container.running) {
      const image = container.images?.fuse;
      if (image) container.start({ image });
      else container.start();
    }
    const port = container.getTcpPort(8080);
    let lastError = "";
    for (let i = 0; i < 100; i++) {
      try {
        const res = await port.fetch("http://container/");
        if (res.ok) return new Response(await res.text());
        lastError = "status " + res.status;
      } catch (error) {
        lastError = String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return new Response("container not ready: " + lastError, { status: 504 });
  }
}

export class FuseImageName extends FuseContainer {}
export class FuseNamedImages extends FuseContainer {}

export default {
  fetch(request, env) {
    const namespace = new URL(request.url).pathname === "/images" ? env.NAMED_IMAGES : env.IMAGE_NAME;
    return namespace.getByName("singleton").fetch(request);
  },
};
`;

// A Linux host without /dev/fuse has no device to pass through.
const canPassFuseDevice = process.platform !== "linux" || existsSync("/dev/fuse");

layer(localRuntimeLayer, { excludeTestServices: true, timeout: 30_000 })(
  "Container FUSE privileges",
  (it) => {
    it.effect.skipIf(!canPassFuseDevice)(
      "gives both image shapes CAP_SYS_ADMIN and /dev/fuse",
      () => {
        const image = { dockerfile: "Dockerfile", context: getFixture("container-fuse") };
        return Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "container-fuse",
            compatibilityDate: "2026-03-17",
            compatibilityFlags: [],
            bindings: [
              DurableObjectNamespace.local({ binding: "IMAGE_NAME", className: "FuseImageName" }),
              DurableObjectNamespace.local({
                binding: "NAMED_IMAGES",
                className: "FuseNamedImages",
              }),
            ],
            modules: [{ name: "main.js", type: "ESModule", content: FUSE_SCRIPT }],
            durableObjectNamespaces: [
              { className: "FuseImageName", sql: true, container: image },
              { className: "FuseNamedImages", sql: true, container: { images: { fuse: image } } },
            ],
          });
          for (const path of ["/image-name", "/images"]) {
            const text = yield* worker.fetchText(path);
            const capEff = /CapEff:\s*([0-9a-f]+)/.exec(text)?.[1];
            expect(capEff, text).toBeDefined();
            // CAP_SYS_ADMIN is capability 21.
            expect((BigInt(`0x${capEff}`) >> 21n) & 1n, text).toBe(1n);
            expect(text).toContain("fuse-device");
          }
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.andThen(
              removeImage("alchemy-dev/fuseimagename"),
              removeImage("alchemy-dev/fusenamedimages"),
            ),
          ),
        );
      },
      60_000,
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
      Effect.ensuring(removeImage(`alchemy-dev/mycontainer${options.index}`)),
    ),
);

/** Best effort: remove every tag matching `reference`. */
const removeImage = (reference: string) =>
  docker(
    "images",
    "--format",
    "{{.Repository}}:{{.Tag}}",
    "--filter",
    `reference=${reference}`,
  ).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .map((image) => image.trim())
        .filter(Boolean),
    ),
    Effect.flatMap((images) => (images.length > 0 ? docker("rmi", ...images) : Effect.void)),
    Effect.ignore,
  );

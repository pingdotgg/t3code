import * as Cloudflare from "@alchemy.run/cloudflare";
import { declareDurableObjectApplication } from "@alchemy.run/cloudflare/Containers/DurableObjectApplication";
import * as Effect from "effect/Effect";
import type { NativeAsyncObject, NativeAsyncReviewer } from "./async-worker.ts";
import { NativeImages } from "./images.ts";
import { NativeLint, NativeShell, NativeTools } from "./object.ts";
import { NativeWorker } from "./worker.ts";

export { NativeImages } from "./images.ts";

/** Shared by both async classes, keyed `AsyncShell` in `ctx.container.images`. */
export const AsyncShell = Cloudflare.Container(
  "AsyncShell",
  Effect.map(NativeImages, ({ shell }) => ({
    schedulingPolicy: "durable_object" as const,
    image: shell,
  })),
);

/** `NativeAsyncObject`'s second image, keyed `AsyncTools`. */
export const AsyncTools = Cloudflare.Container(
  "AsyncTools",
  Effect.map(NativeImages, ({ tools }) => ({
    schedulingPolicy: "durable_object" as const,
    image: tools,
  })),
);

/** `NativeAsyncReviewer`'s second image, keyed `AsyncLint`. */
export const AsyncLint = Cloudflare.Container("AsyncLint", {
  schedulingPolicy: "durable_object",
  image: "alpine:3.19",
});

/**
 * Two classes on one async Worker, each with its own container application.
 * `tools: undefined` removes `AsyncTools` from `NativeAsyncObject`.
 */
export const NativeAsyncWorker = Cloudflare.Worker(
  "NativeAsyncWorker",
  Effect.map(NativeImages, (images) => ({
    main: `${import.meta.dirname}/async-worker.ts`,
    env: {
      SANDBOX: Cloudflare.DurableObject<NativeAsyncObject>("NativeAsyncObject", {
        containers: images.tools === undefined ? [AsyncShell] : [AsyncShell, AsyncTools],
      }),
      REVIEWER: Cloudflare.DurableObject<NativeAsyncReviewer>("NativeAsyncReviewer", {
        containers: [AsyncShell, AsyncLint],
      }),
      IMAGE_REVISION: JSON.stringify(images),
    },
  })),
);

export const nativeStack = Effect.gen(function* () {
  const worker = yield* NativeWorker;
  const asyncWorker = yield* NativeAsyncWorker;
  return {
    worker,
    asyncWorker,
    shell: yield* NativeShell.Application,
    tools: yield* NativeTools.Application,
    lint: yield* NativeLint.Application,
    asyncShell: yield* AsyncShell.Application,
    // Each class's one container application, shared by its Containers.
    application: yield* declareDurableObjectApplication(worker, "NativeObject"),
    reviewerApplication: yield* declareDurableObjectApplication(worker, "NativeReviewer"),
    asyncApplication: yield* declareDurableObjectApplication(asyncWorker, "NativeAsyncObject"),
    asyncReviewerApplication: yield* declareDurableObjectApplication(
      asyncWorker,
      "NativeAsyncReviewer",
    ),
  };
});

/** The removed async form: a Durable Object-managed Container directly in `env`. */
export const directEnvStack = Effect.gen(function* () {
  return yield* Cloudflare.Worker("DirectEnvWorker", {
    main: `${import.meta.dirname}/async-worker.ts`,
    env: { SANDBOX: AsyncShell, IMAGE_REVISION: "direct" },
  });
});

/**
 * An async Worker that gains its second container-backed class,
 * `NativeAsyncReviewer`, on a later deploy (`withReviewer`).
 */
export const growingStack = (withReviewer: boolean) =>
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("GrowingAsyncWorker", {
      main: `${import.meta.dirname}/async-worker.ts`,
      env: {
        SANDBOX: Cloudflare.DurableObject<NativeAsyncObject>("NativeAsyncObject", {
          containers: [AsyncShell],
        }),
        ...(withReviewer
          ? {
              REVIEWER: Cloudflare.DurableObject<NativeAsyncReviewer>("NativeAsyncReviewer", {
                containers: [AsyncShell, AsyncLint],
              }),
            }
          : {}),
        IMAGE_REVISION: "growing",
      },
    });
    return {
      worker,
      reviewerApplication: withReviewer
        ? yield* declareDurableObjectApplication(worker, "NativeAsyncReviewer")
        : undefined,
    };
  });

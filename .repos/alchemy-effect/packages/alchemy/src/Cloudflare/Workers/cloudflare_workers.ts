import * as Effect from "effect/Effect";

const cloudflare_workers: Effect.Effect<typeof import("cloudflare:workers")> =
  /** @__PURE__ #__PURE__ */ Effect.promise(() =>
    import("cloudflare:workers").catch(
      () =>
        ({
          env: {},
          DurableObject: class {},
          WorkflowEntrypoint: class {
            async run() {}
          },
        }) as any,
    ),
  );

export default cloudflare_workers;

import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Browser as BrowserLike } from "./Browser.ts";

export class BrowserError extends Data.TaggedError("BrowserError")<{
  message: string;
  cause: unknown;
}> {}

export interface BrowserHandle {
  close(): Promise<void>;
}

export interface BrowserPuppeteer<Browser extends BrowserHandle> {
  launch(binding: cf.Fetcher): Promise<Browser>;
}

/**
 * Effect-native client for a Cloudflare Browser Rendering binding.
 *
 * Browser Rendering's Workers binding is consumed by `@cloudflare/puppeteer`.
 * Alchemy keeps Puppeteer as a caller-provided dependency while wrapping
 * launch and cleanup in Effects.
 */
export interface BrowserClient {
  /**
   * Effect resolving to the raw Cloudflare Browser Rendering runtime binding.
   */
  raw: Effect.Effect<cf.Fetcher, never, WorkerEnvironment>;
  /**
   * Launch a Browser Rendering session through `@cloudflare/puppeteer`.
   */
  launch<Browser extends BrowserHandle>(
    puppeteer: BrowserPuppeteer<Browser>,
  ): Effect.Effect<Browser, BrowserError, WorkerEnvironment>;
  /**
   * Launch a browser, run an Effect with it, and close it afterward.
   */
  withBrowser<Browser extends BrowserHandle, A, E, R>(
    puppeteer: BrowserPuppeteer<Browser>,
    use: (browser: Browser) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, BrowserError | E, WorkerEnvironment | R>;
}

export class BrowserBinding extends Binding.Service<
  BrowserBinding,
  (browser: BrowserLike) => Effect.Effect<BrowserClient>
>()("Cloudflare.Browser.Binding") {}

export const BrowserBindingLive = Layer.effect(
  BrowserBinding,
  Effect.gen(function* () {
    const Policy = yield* BrowserBindingPolicy;

    return Effect.fn(function* (browser: BrowserLike) {
      yield* Policy(browser);
      // Cloudflare exposes Browser Rendering as a service-style binding for
      // @cloudflare/puppeteer; workers-types has no narrower interface.
      const raw = WorkerEnvironment.useSync(
        (env) => (env as Record<string, cf.Fetcher>)[browser.name]!,
      );
      return makeBrowserClient(raw);
    });
  }),
);

export class BrowserBindingPolicy extends Binding.Policy<
  BrowserBindingPolicy,
  (browser: BrowserLike) => Effect.Effect<void>
>()("Cloudflare.Browser.Binding") {}

export const BrowserBindingPolicyLive = BrowserBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, browser: BrowserLike) {
    if (isWorker(host)) {
      yield* host.bind(browser.name, {
        bindings: [
          {
            type: "browser",
            name: browser.name,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`BrowserBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, BrowserError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new BrowserError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown Browser Rendering error",
        cause: error,
      }),
  });

/** @internal */
export const makeBrowserClient = (
  raw: Effect.Effect<cf.Fetcher, never, WorkerEnvironment>,
): BrowserClient => {
  const launch = <Browser extends BrowserHandle>(
    puppeteer: BrowserPuppeteer<Browser>,
  ) =>
    raw.pipe(
      Effect.flatMap((binding) => tryPromise(() => puppeteer.launch(binding))),
    );

  return {
    raw,
    launch,
    withBrowser: (puppeteer, use) =>
      Effect.acquireUseRelease(launch(puppeteer), use, (browser) =>
        tryPromise(() => browser.close()),
      ),
  } satisfies BrowserClient;
};

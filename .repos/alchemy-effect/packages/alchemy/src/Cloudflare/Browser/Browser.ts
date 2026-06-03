import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import { BrowserBinding, type BrowserClient } from "./BrowserBinding.ts";

type BrowserTypeId = typeof BrowserTypeId;
const BrowserTypeId = "Cloudflare.Browser" as const;

export type BrowserProps = {
  /**
   * Binding name used when `Browser` is bound from inside a Worker init phase
   * (`yield* Cloudflare.Browser(...)`). When passed through
   * `Worker({ env: { ... } })`, the object key remains the binding name.
   *
   * @default "BROWSER"
   */
  name?: string;
};

/**
 * The Effect yielded when a `Browser` marker is used inside a Worker init
 * phase: it attaches the `browser` binding to the surrounding Worker and
 * resolves to the runtime {@link BrowserClient}.
 */
type BindEffect = Effect.Effect<BrowserClient, never, BrowserBinding>;

/**
 * Marker for a Cloudflare Browser Rendering binding.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.Browser(...)`) attaches the binding to the surrounding
 * Worker and returns the runtime {@link BrowserClient} — no separate
 * `.bind(...)` step required.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is not an
 * `Effect` (so `InferEnv` resolves it to the native `Fetcher` in the `env`
 * position), but it is iterable as one when `yield*`-ed.
 */
export interface Browser {
  kind: BrowserTypeId;
  name: string;
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, BrowserClient>;
}

export const isBrowser = (value: unknown): value is Browser =>
  typeof value === "object" && (value as Browser)?.kind === BrowserTypeId;

/**
 * A Cloudflare Browser Rendering binding for launching headless browser
 * sessions from Workers via `@cloudflare/puppeteer`.
 *
 * @binding
 *
 * @section Effect-style Worker (recommended)
 * @example Render a page title with managed browser cleanup
 * ```typescript
 * import puppeteer from "@cloudflare/puppeteer";
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "BrowserWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns the runtime client.
 *     const browser = yield* Cloudflare.Browser({ name: "BROWSER" });
 *
 *     return {
 *       fetch: browser.withBrowser(puppeteer, (browser) =>
 *         Effect.gen(function* () {
 *           const page = yield* Effect.tryPromise(() => browser.newPage());
 *           yield* Effect.tryPromise(() => page.goto("https://example.com"));
 *           const title = yield* Effect.tryPromise(() => page.title());
 *           return Response.json({ title });
 *         }),
 *       ),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.BrowserBindingLive)),
 * );
 * ```
 *
 * @section Worker binding metadata
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     BROWSER: Cloudflare.Browser(),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { BROWSER: Fetcher }
 * ```
 *
 * @example Async-style worker with the raw runtime binding
 * ```typescript
 * import puppeteer from "@cloudflare/puppeteer";
 * import type { WorkerEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     const browser = await puppeteer.launch(env.BROWSER);
 *     const page = await browser.newPage();
 *     await page.goto("https://example.com");
 *     const screenshot = await page.screenshot();
 *     await browser.close();
 *
 *     return new Response(screenshot, {
 *       headers: { "content-type": "image/png" },
 *     });
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/browser-rendering/workers-binding-api/
 */
export const Browser: {
  (props?: BrowserProps): Browser;
  /**
   * Bind an existing `Browser` marker to the surrounding Worker, returning the
   * runtime client. Equivalent to `yield* browser` — prefer yielding the marker
   * directly.
   */
  bind: typeof BrowserBinding.bind;
} = Object.assign(
  (props?: BrowserProps): Browser => {
    const self: Browser = {
      kind: BrowserTypeId,
      name: props?.name ?? "BROWSER",
      asEffect: () => BrowserBinding.bind(self),
      [Symbol.iterator]: () => new SingleShotGen(BrowserBinding.bind(self)),
    };
    return self;
  },
  {
    bind: (...args: Parameters<typeof BrowserBinding.bind>) =>
      BrowserBinding.bind(...args),
  },
);

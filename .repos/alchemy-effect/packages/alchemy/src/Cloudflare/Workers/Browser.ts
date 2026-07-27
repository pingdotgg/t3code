import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";

const TypeId = "Cloudflare.Browser" as const;
type TypeId = typeof TypeId;

export class BrowserError extends Data.TaggedError("BrowserError")<{
  message: string;
  cause: unknown;
}> {}

/** The `Response` type returned by the Cloudflare Browser Rendering binding. */
export type BrowserResponse = Awaited<ReturnType<cf.BrowserRun["fetch"]>>;

/** An Effect produced by a {@link BrowserClient} operation. */
type BrowserEffect<A> = Effect.Effect<A, BrowserError, RuntimeContext>;

/** A byte stream produced by a binary {@link BrowserClient} action. */
type BrowserByteStream = Stream.Stream<
  Uint8Array,
  BrowserError,
  RuntimeContext
>;

// Quick action option types, re-exported so callers don't reach into the
// `@cloudflare/workers-types` namespace directly.
export type BrowserScreenshotOptions = cf.BrowserRunScreenshotOptions;
export type BrowserPDFOptions = cf.BrowserRunPDFOptions;
export type BrowserContentOptions = cf.BrowserRunContentOptions;
export type BrowserScrapeOptions = cf.BrowserRunScrapeOptions;
export type BrowserLinksOptions = cf.BrowserRunLinksOptions;
export type BrowserSnapshotOptions = cf.BrowserRunSnapshotOptions;
export type BrowserJsonOptions = cf.BrowserRunJsonOptions;
export type BrowserMarkdownOptions = cf.BrowserRunMarkdownOptions;

// Quick action success payloads.
export type BrowserContentResult = cf.BrowserRunContentSuccessResponse;
export type BrowserScrapeResult = cf.BrowserRunScrapeSuccessResponse;
export type BrowserLinksResult = cf.BrowserRunLinksSuccessResponse;
export type BrowserSnapshotResult = cf.BrowserRunSnapshotSuccessResponse;
export type BrowserJsonResult = cf.BrowserRunJsonSuccessResponse;
export type BrowserMarkdownResult = cf.BrowserRunMarkdownSuccessResponse;
export type BrowserErrorResponse = cf.BrowserRunErrorResponse;

/**
 * Effect-native client for a Cloudflare Browser Rendering binding.
 *
 * Mirrors the runtime {@link cf.BrowserRun} binding, translating its shapes into
 * Effect-native ones: JSON quick actions resolve to their parsed success
 * payload, and binary actions (`screenshot`, `pdf`) resolve to a `Stream` of the
 * response bytes. Non-success responses fail with {@link BrowserError}. The
 * {@link raw} accessor and {@link fetch} are the promise-shaped escape hatches
 * for libraries like `@cloudflare/puppeteer`.
 */
export interface BrowserClient {
  /** Effect resolving to the raw Cloudflare Browser Rendering runtime binding. */
  raw: Effect.Effect<cf.BrowserRun, never, RuntimeContext>;
  /** Send a raw HTTP request to the Browser Run API. */
  fetch(
    ...args: Parameters<cf.BrowserRun["fetch"]>
  ): BrowserEffect<BrowserResponse>;
  /** Run a Browser Run quick action, resolving to the parsed payload. */
  quickAction(
    action: "screenshot",
    options: BrowserScreenshotOptions,
  ): BrowserByteStream;
  quickAction(action: "pdf", options: BrowserPDFOptions): BrowserByteStream;
  quickAction(
    action: "content",
    options: BrowserContentOptions,
  ): BrowserEffect<BrowserContentResult>;
  quickAction(
    action: "scrape",
    options: BrowserScrapeOptions,
  ): BrowserEffect<BrowserScrapeResult>;
  quickAction(
    action: "links",
    options: BrowserLinksOptions,
  ): BrowserEffect<BrowserLinksResult>;
  quickAction(
    action: "snapshot",
    options: BrowserSnapshotOptions,
  ): BrowserEffect<BrowserSnapshotResult>;
  quickAction(
    action: "json",
    options: BrowserJsonOptions,
  ): BrowserEffect<BrowserJsonResult>;
  quickAction(
    action: "markdown",
    options: BrowserMarkdownOptions,
  ): BrowserEffect<BrowserMarkdownResult>;
  /** Take a screenshot of a web page, streaming the raw image bytes. */
  screenshot(options: BrowserScreenshotOptions): BrowserByteStream;
  /** Generate a PDF of a web page, streaming the raw PDF bytes. */
  pdf(options: BrowserPDFOptions): BrowserByteStream;
  /** Get the HTML content of a web page. */
  content(options: BrowserContentOptions): BrowserEffect<BrowserContentResult>;
  /** Scrape elements from a web page by CSS selector. */
  scrape(options: BrowserScrapeOptions): BrowserEffect<BrowserScrapeResult>;
  /** Extract all links from a web page. */
  links(options: BrowserLinksOptions): BrowserEffect<BrowserLinksResult>;
  /** Get both the HTML content and a base64-encoded screenshot of a web page. */
  snapshot(
    options: BrowserSnapshotOptions,
  ): BrowserEffect<BrowserSnapshotResult>;
  /** Extract structured JSON data from a web page using AI. */
  json(options: BrowserJsonOptions): BrowserEffect<BrowserJsonResult>;
  /** Convert a web page to Markdown. */
  markdown(
    options: BrowserMarkdownOptions,
  ): BrowserEffect<BrowserMarkdownResult>;
}

/**
 * A Cloudflare Browser Rendering binding for launching headless browser sessions
 * from Workers — a Worker-only binding with no backing cloud resource.
 *
 * `Browser` is a single value that is at once the `Binding.Service` tag, the
 * callable that produces a {@link BrowserBinding}, and the type. Declare it on a
 * Worker's `env` (it flows through `InferEnv` → `cf.BrowserRun`) or `yield*` it
 * inside an Effect-native Worker to attach the binding and obtain the
 * {@link BrowserClient}.
 *
 * @binding
 * @product Browser Rendering
 * @category Developer Platform
 * @section Effect-style Worker (recommended)
 * @example Bind the runtime client and convert a page to Markdown
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "BrowserWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const browser = yield* Cloudflare.Browser("BROWSER");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* browser.markdown({ url: "https://example.com" });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.BrowserBinding)),
 * );
 * ```
 *
 * @section Worker binding metadata
 * @example Declare the binding on `env`
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { BROWSER: Cloudflare.Browser() },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { BROWSER: BrowserRun }
 * ```
 *
 * @see https://developers.cloudflare.com/browser-rendering/workers-binding-api/
 */
export interface Browser extends Binding.Service<
  Browser,
  TypeId,
  BrowserClient
> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   * @default "BROWSER"
   */
  (name?: string): BrowserBinding;
}

export const Browser = Binding.Service<Browser>({
  id: TypeId,
  defaultName: "BROWSER",
  toWorkerBinding: (binding) => ({ type: "browser", name: binding.name }),
});

export const isBrowser = (value: unknown): value is BrowserBinding =>
  Binding.isBinding(value) && value.kind === TypeId;

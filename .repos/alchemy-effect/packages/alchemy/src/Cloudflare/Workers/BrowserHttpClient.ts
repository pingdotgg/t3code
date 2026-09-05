import * as browser from "@distilled.cloud/cloudflare/browser-rendering";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Credentials } from "../Credentials.ts";
import {
  type BrowserClient,
  type BrowserContentResult,
  BrowserError,
  type BrowserJsonResult,
  type BrowserLinksResult,
  type BrowserMarkdownResult,
  type BrowserScrapeResult,
  type BrowserSnapshotResult,
} from "./Browser.ts";

// Shared HTTP scaffolding for the Browser Rendering binding. NOT re-exported
// from `index.ts` — only the contract and the impl layers are public. A future
// token-scoped `BrowserHttp` layer reuses this builder with an auth minted from
// an `AccountApiToken`; `BrowserLocal` builds the auth from the ambient
// current-credentials context.

/**
 * Injectable auth shared by the Local (current-credentials) impl and a future
 * Http (scoped-token) impl. `authorize` discharges the
 * `Credentials | HttpClient` requirement of a distilled op; `accountId` is the
 * Cloudflare account the ops run against.
 */
export interface BrowserAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>;
  accountId: string;
}

/** A byte stream produced by a binary {@link BrowserClient} action. */
type BrowserByteStream = Stream.Stream<
  Uint8Array,
  BrowserError,
  RuntimeContext
>;

/**
 * Build a {@link BrowserClient} over the Browser Rendering REST data-plane
 * (`/accounts/{id}/browser-rendering/*`).
 *
 * The following client members `Effect.die` (or fail the stream) because they
 * have no Cloudflare REST equivalent — use a native `BrowserBinding` inside a
 * deployed Worker for them:
 * - `raw` / `fetch` — the raw `BrowserRun` transport used by
 *   `@cloudflare/puppeteer` is a Worker-runtime object, not an HTTP call.
 * - `screenshot` / `pdf` — the binary endpoints stream image/PDF bytes, which
 *   the distilled REST codec models as JSON status, not a byte stream.
 *
 * Because the REST data-plane only returns the action `result` (not the
 * runtime binding's `meta` envelope), `content`/`snapshot` populate `meta`
 * with a best-effort placeholder.
 */
export const makeHttpBrowserClient = (auth: BrowserAuth): BrowserClient => {
  // Run a distilled Browser Rendering op with the injected auth and surface
  // transport/API failures as {@link BrowserError} (matching the native
  // binding's declared error channel).
  const run = <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, BrowserError, RuntimeContext> =>
    auth.authorize(eff).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserError({
            message: "Browser Rendering request failed",
            cause,
          }),
      ),
    );

  // The cf option types (`url`/`html` + puppeteer options) are structurally the
  // REST request body; add the account id and let distilled's encoder drop any
  // fields it doesn't model.
  const req = (options: unknown) =>
    ({ accountId: auth.accountId, ...(options as object) }) as never;

  const content = (options: unknown) =>
    run(browser.createContent(req(options))).pipe(
      Effect.map(
        (result): BrowserContentResult => ({
          success: true,
          result,
          meta: { status: 200, title: "" },
        }),
      ),
    );

  const markdown = (options: unknown) =>
    run(browser.createMarkdown(req(options))).pipe(
      Effect.map(
        (result): BrowserMarkdownResult => ({ success: true, result }),
      ),
    );

  const links = (options: unknown) =>
    run(browser.createLink(req(options))).pipe(
      Effect.map(
        (result): BrowserLinksResult => ({
          success: true,
          result: [...result],
        }),
      ),
    );

  const json = (options: unknown) =>
    run(browser.createJson(req(options))).pipe(
      Effect.map((result): BrowserJsonResult => ({ success: true, result })),
    );

  const scrape = (options: unknown) =>
    run(browser.createScrape(req(options))).pipe(
      Effect.map(
        (result): BrowserScrapeResult => ({
          success: true,
          result: result.map((item) => ({
            selector: item.selector,
            // distilled models per-selector `results` as a single object; the
            // native shape is an array of matched elements.
            results: (Array.isArray(item.results)
              ? item.results
              : [
                  item.results,
                ]) as BrowserScrapeResult["result"][number]["results"],
          })),
        }),
      ),
    );

  const snapshot = (options: unknown) =>
    run(browser.createSnapshot(req(options))).pipe(
      Effect.map(
        (result): BrowserSnapshotResult => ({
          success: true,
          result: {
            content: result.content ?? "",
            screenshot: result.screenshot ?? "",
          },
          meta: { status: 200, title: "" },
        }),
      ),
    );

  // Binary actions have no REST byte-stream equivalent through the distilled
  // codec — fail the stream with a defect explaining the native-binding path.
  const binaryUnsupported = (action: string): BrowserByteStream =>
    Stream.fromEffect(
      Effect.die(
        new Error(
          `Browser over HTTP: '${action}' returns binary data and is only available inside a Worker via the native BrowserBinding; the HTTP client supports the JSON quick actions (content/markdown/scrape/links/snapshot/json).`,
        ),
      ),
    ) as BrowserByteStream;

  const quickAction = ((action: string, options: unknown) => {
    switch (action) {
      case "content":
        return content(options);
      case "markdown":
        return markdown(options);
      case "links":
        return links(options);
      case "json":
        return json(options);
      case "scrape":
        return scrape(options);
      case "snapshot":
        return snapshot(options);
      default:
        return binaryUnsupported(action);
    }
  }) as BrowserClient["quickAction"];

  return {
    raw: Effect.die(
      new Error(
        "Browser over HTTP: `raw` (the native BrowserRun binding) is only available inside a deployed Worker — use BrowserBinding.",
      ),
    ),
    fetch: () =>
      Effect.die(
        new Error(
          "Browser over HTTP: `fetch` proxies the raw Browser Run transport used by @cloudflare/puppeteer and is only available inside a Worker via BrowserBinding.",
        ),
      ),
    quickAction,
    screenshot: () => binaryUnsupported("screenshot"),
    pdf: () => binaryUnsupported("pdf"),
    content,
    scrape,
    links,
    snapshot,
    json,
    markdown,
  } satisfies BrowserClient;
};

import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import { makeBindingLayer } from "./BindingLayer.ts";
import {
  Browser,
  type BrowserClient,
  BrowserError,
  type BrowserResponse,
} from "./Browser.ts";

/** The binding value produced by calling {@link Browser} (declared on `env` or `yield*`-ed). */
export type BrowserBinding = Binding.Binding<
  Browser["key"],
  BrowserClient,
  Browser
>;

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Workers Browser Rendering binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.BrowserBinding)`)
 * so that yielding a {@link Browser} binding attaches the native `browser`
 * binding to the surrounding Worker at deploy time and, at runtime, resolves to
 * the Effect-native {@link BrowserClient}.
 */
export const BrowserBinding = makeBindingLayer<
  Browser,
  cf.BrowserRun,
  BrowserClient
>(Browser, (raw): BrowserClient => {
  const respond = (
    action: string,
    options: unknown,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext> =>
    raw.pipe(
      Effect.flatMap((binding) =>
        tryPromise(() => binding.quickAction(action as any, options as any)),
      ),
      Effect.flatMap((response) =>
        response.ok ? Effect.succeed(response) : failResponse(action, response),
      ),
    );

  const jsonAction = <T>(
    action: string,
    options: unknown,
  ): Effect.Effect<T, BrowserError, RuntimeContext> =>
    respond(action, options).pipe(
      Effect.flatMap((response) =>
        tryPromise(() => response.json() as Promise<T>),
      ),
    );

  const streamAction = (
    action: string,
    options: unknown,
  ): Stream.Stream<Uint8Array, BrowserError, RuntimeContext> =>
    respond(action, options).pipe(
      Effect.map((response) =>
        Stream.fromReadableStream({
          evaluate: () =>
            response.body as any as ReadableStream<Uint8Array<ArrayBufferLike>>,
          onError: (cause) =>
            new BrowserError({
              message: `Browser Rendering '${action}' stream failed`,
              cause,
            }),
        }),
      ),
      Stream.unwrap,
    );

  const quickAction = ((action: string, options: unknown) =>
    BINARY_ACTIONS.has(action)
      ? streamAction(action, options)
      : jsonAction(action, options)) as BrowserClient["quickAction"];

  return {
    raw,
    fetch: (...args) =>
      raw.pipe(
        Effect.flatMap((binding) => tryPromise(() => binding.fetch(...args))),
      ),
    quickAction,
    screenshot: (options) => streamAction("screenshot", options),
    pdf: (options) => streamAction("pdf", options),
    content: (options) => jsonAction("content", options),
    scrape: (options) => jsonAction("scrape", options),
    links: (options) => jsonAction("links", options),
    snapshot: (options) => jsonAction("snapshot", options),
    json: (options) => jsonAction("json", options),
    markdown: (options) => jsonAction("markdown", options),
  } satisfies BrowserClient;
});

/** Actions whose successful response is raw binary rather than JSON. */
const BINARY_ACTIONS = new Set(["screenshot", "pdf"]);

/** Build a {@link BrowserError} from a non-success Browser Run response. */
const failResponse = (
  action: string,
  response: BrowserResponse,
): Effect.Effect<never, BrowserError> =>
  tryPromise(() => response.text()).pipe(
    Effect.flatMap((body) => {
      let cause: unknown = body;
      try {
        cause = JSON.parse(body);
      } catch {
        // keep the raw text as the cause
      }
      const message =
        (cause as cf.BrowserRunErrorResponse | undefined)?.errors?.[0]
          ?.message ??
        `Browser Rendering '${action}' failed with status ${response.status}`;
      return Effect.fail(new BrowserError({ message, cause }));
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

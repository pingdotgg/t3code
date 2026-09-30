import { OpenCode, type OpenCodeClient } from "@opencode/client/effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/** OpenCode 2 accepts only HTTP Basic auth, always with this user name. */
const OPENCODE_USERNAME = "opencode";

/** Builds Effect clients for OpenCode 2 servers, one per base URL and password. */
export class OpenCode2Client extends Context.Service<
  OpenCode2Client,
  {
    /**
     * Connects with HTTP Basic auth (`opencode:<password>`) on every
     * request — the only auth the 2.x server accepts (verified E2E: Bearer,
     * query-param, and password-only variants all 401). The password stays
     * `Redacted` so it never lands in spans, logs, or error causes.
     */
    readonly connect: (input: {
      readonly baseUrl: string;
      readonly password: Redacted.Redacted;
    }) => Effect.Effect<OpenCodeClient>;
  }
>()("t3/provider/opencode2/OpenCode2Client") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return OpenCode2Client.of({
    connect: ({ baseUrl, password }) =>
      OpenCode.make({ baseUrl }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.mapRequest(
            httpClient,
            HttpClientRequest.basicAuth(OPENCODE_USERNAME, password),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(OpenCode2Client, make);

/**
 * Streams every item of a cursor-paged OpenCode 2 list. The first request
 * carries the caller's input (including `order`); later requests resend
 * the input with `order` cleared and only the cursor advanced, because
 * OpenCode rejects a cursor combined with `order`.
 *
 * A server that answers every page with a fresh cursor but no terminal page
 * would otherwise stream forever: after `maxPages` non-terminal pages the
 * stream ends as if the cursor had run out, so callers always observe a
 * finite list. The default (1,000 pages) is orders of magnitude past real
 * inventories and histories.
 */
export const paginate = <Input extends { readonly cursor?: unknown }, Item, E, R>(
  input: Input,
  list: (
    input: Input,
  ) => Effect.Effect<
    { readonly data: ReadonlyArray<Item>; readonly cursor: { readonly next?: Input["cursor"] } },
    E,
    R
  >,
  options?: { readonly maxPages?: number },
): Stream.Stream<Item, E, R> => {
  const maxPages =
    options?.maxPages !== undefined && Number.isFinite(options.maxPages)
      ? Math.max(1, Math.floor(options.maxPages))
      : 1_000;
  // The paginate state carries the remaining-page budget alongside the
  // request; only the request itself is sent to the server.
  return Stream.paginate({ request: input, remaining: maxPages }, ({ request, remaining }) =>
    list(request).pipe(
      Effect.map(
        (page) =>
          [
            page.data,
            page.data.length === 0 || page.cursor.next === undefined || remaining <= 1
              ? Option.none()
              : Option.some({
                  request: { ...request, order: undefined, cursor: page.cursor.next },
                  remaining: remaining - 1,
                }),
          ] as const,
      ),
    ),
  );
};

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { Browser } from "./Browser.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";
import {
  type BrowserAuth,
  makeHttpBrowserClient,
} from "./BrowserHttpClient.ts";

/**
 * Local implementation of the {@link Browser} binding — drives Cloudflare
 * Browser Rendering over its REST data-plane (`/accounts/{id}/browser-rendering/*`)
 * using the **current credentials** instead of a native Worker binding
 * (`BrowserBinding`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) to run the JSON
 * quick actions — `content`, `markdown`, `scrape`, `links`, `snapshot`,
 * `json` — with the same client you'd use inside a Worker; no Worker host, no
 * `host.bind`, no minted token:
 *
 * @example Convert a page to Markdown from an Action
 * ```typescript
 * const Scrape = Alchemy.Action(
 *   "Scrape",
 *   Effect.gen(function* () {
 *     const browser = yield* Cloudflare.Browser("BROWSER");
 *     return Effect.fn(function* () {
 *       const { result } = yield* browser.markdown({
 *         url: "https://example.com",
 *       });
 *       return result;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Workers.BrowserLocal)),
 * );
 * ```
 *
 * `raw`, `fetch`, and the binary actions (`screenshot`/`pdf`) have no
 * Cloudflare REST equivalent and die — see {@link makeHttpBrowserClient}.
 */
export const BrowserLocal = Layer.effect(
  Browser,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the REST ops run with the
    // current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth: BrowserAuth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
      accountId,
    };

    return Effect.fn(function* (_binding: BrowserBinding) {
      // Browser Rendering is account-scoped; the binding carries no cloud
      // resource id, so nothing to resolve — the client only needs the account
      // + injected auth.
      return makeHttpBrowserClient(auth);
    });
  }),
);

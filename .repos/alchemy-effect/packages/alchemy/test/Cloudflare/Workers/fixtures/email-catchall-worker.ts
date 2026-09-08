import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const ZoneConfig = Config.string("CLOUDFLARE_TEST_DNS_ZONE_NAME").pipe(
  Config.withDefault("alchemy-test-2.us"),
);

/**
 * Fixture for the catch-all form of the event source: `email({ zone })`
 * with no `matchers`. Cloudflare rejects a lone `{ type: "all" }` matcher
 * on `createRule` outright ("Invalid rule operation"), so this shape only
 * works if the event source provisions `Email.CatchAll` instead.
 */
export default class EmailCatchAllWorker extends Cloudflare.Worker<EmailCatchAllWorker>()(
  "EmailCatchAllWorker",
  {
    main: import.meta.filename,
    workersDev: { enabled: true, previewsEnabled: false },
  },
  Effect.gen(function* () {
    const zone = yield* ZoneConfig;

    yield* Cloudflare.email({ zone }).subscribe((message) =>
      Effect.log(`received mail for ${message.to}`),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
) {}

import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Hard-coded values the integ test asserts against to prove the
 * deploy-time bindings flow all the way through to the runtime.
 */
export const LITERAL_SECRET_VALUE = "sk-literal-secret-abc";
export const STRING_VAR_VALUE = "plain-string-value";
export const NUMBER_VAR_VALUE = 4242;
export const OBJECT_VAR_VALUE = { host: "localhost", flags: { beta: true } };

/**
 * Name of the deploy-time `process.env` variable the test populates
 * before deploying — sourced via `Config.string(...)` inside the
 * worker's init phase.
 */

export default class SecretsTestWorker extends Cloudflare.Worker<SecretsTestWorker>()(
  "SecretsTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
  },
  Effect.gen(function* () {
    // Secret from a literal — `Alchemy.Secret` coerces the literal to
    // `Redacted` and the Worker provider deploys it as `secret_text`.
    const literalSecret = yield* Config.redacted("LITERAL_SECRET").pipe(
      Config.withDefault(Redacted.make(LITERAL_SECRET_VALUE)),
    );

    // Secret from a `Config` — resolved against the active
    // `ConfigProvider` (process.env) at deploy time.
    const configSecret = yield* Config.redacted("CONFIG_SECRET");

    // Plain string variable — `plain_text` binding round-trip.
    const stringVar = yield* Config.string("STRING_VAR").pipe(
      Config.withDefault(STRING_VAR_VALUE),
    );

    // Number variable — non-string values JSON.stringify on `set` and
    // JSON.parse on the runtime accessor, so the accessor returns the
    // original number.
    const numberVar = yield* Config.number("NUMBER_VAR").pipe(
      Config.withDefault(NUMBER_VAR_VALUE),
    );

    // Object variable — same JSON round-trip as above for nested data.
    const objectVar = yield* Config.string("OBJECT_VAR").pipe(
      Config.withDefault(OBJECT_VAR_VALUE),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` on Cloudflare workers is the pathname+query
        // (relative). Use `originalUrl` to get the absolute URL so
        // `new URL(...)` doesn't throw.
        const pathname = new URL(request.originalUrl).pathname;
        switch (pathname) {
          case "/secret/literal": {
            return yield* HttpServerResponse.json({
              isRedacted: Redacted.isRedacted(literalSecret),
              value: Redacted.value(literalSecret),
            });
          }
          case "/secret/config": {
            return yield* HttpServerResponse.json({
              isRedacted: Redacted.isRedacted(configSecret),
              value: Redacted.value(configSecret),
            });
          }
          case "/var/string": {
            return yield* HttpServerResponse.json({
              type: typeof stringVar,
              value: stringVar,
            });
          }
          case "/var/number": {
            return yield* HttpServerResponse.json({
              type: typeof numberVar,
              value: numberVar,
            });
          }
          case "/var/object": {
            return yield* HttpServerResponse.json({
              type: typeof objectVar,
              value: objectVar,
            });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }),
) {}

import * as Lambda from "@/AWS/Lambda";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Hard-coded values the integ test asserts against to prove the
 * deploy-time bindings flow all the way through to the runtime.
 */
export const LITERAL_SECRET_VALUE = "sk-aws-literal-secret-abc";
export const STRING_VAR_VALUE = "plain-aws-string-value";
export const NUMBER_VAR_VALUE = 9090;
export const OBJECT_VAR_VALUE = {
  region: "us-east-1",
  flags: { canary: true },
};

/**
 * Name of the deploy-time `process.env` variable the test populates
 * before deploying — sourced via `Config.string(...)` inside the
 * Lambda's init phase.
 */
export const CONFIG_SECRET_ENV_KEY = "ALCHEMY_AWS_SECRET_TEST_SOURCE";

export class SecretsTestFunction extends Lambda.Function<SecretsTestFunction>()(
  "SecretsTestFunction",
) {}

export const SecretsTestFunctionLive = SecretsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Secret from a literal — `Alchemy.Secret` coerces the literal to
    // `Redacted` and the Lambda runtime accessor rebuilds the wrapper
    // from the JSON marker stored in env.
    const literalSecret = yield* Config.redacted("LITERAL_SECRET").pipe(
      Config.withDefault(Redacted.make(LITERAL_SECRET_VALUE)),
    );

    // Secret from a `Config` — resolved against the active
    // `ConfigProvider` (process.env) at deploy time. The test populates
    // `process.env[CONFIG_SECRET_ENV_KEY]` before deploying, so source
    // from that same key (not a hard-coded literal).
    const configSecret = yield* Config.redacted(CONFIG_SECRET_ENV_KEY);

    // Plain string variable — string round-trip.
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
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        switch (pathname) {
          case "/ready":
            return HttpServerResponse.text("ok");
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
            return yield* HttpServerResponse.json(
              { error: "Not found", pathname },
              { status: 404 },
            );
        }
      }).pipe(Effect.orDie),
    };
  }),
);

export default SecretsTestFunctionLive;

import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture that exercises every supported
 * `WorkerBindingResource` shape and echoes the resolved values back as
 * JSON so the test can assert the deploy → runtime round-trip.
 *
 * Mixes the two declaration styles:
 *   - `env: { ... }` literal/Redacted/Config values declared on the
 *     resource (resolved via `WorkerEnvironment` at runtime).
 *   - `yield* Config.xxx(...)` resolved during Init — Alchemy captures
 *     the binding automatically and the same `Config` re-resolves from
 *     the binding at runtime.
 */
export default class EnvEffectWorker extends Cloudflare.Worker<EnvEffectWorker>()(
  "EnvEffectWorker",
  {
    main: import.meta.filename,
    env: {
      STR: "hello",
      NUM: 42,
      BOOL: true,
      NULL: null,
      OBJ: { nested: { value: "ok" }, count: 7 },
      ARR: [1, 2, 3],
      SECRET_STR: Redacted.make("shh"),
      SECRET_JSON: Redacted.make({ token: "abc", scopes: ["read", "write"] }),
      // Config declared statically on `env` — Alchemy resolves at deploy
      // time and binds it as `secret_text` on the Worker.
      CONFIG_REDACTED: Config.redacted("CONFIG_REDACTED"),
    },
  },
  Effect.gen(function* () {
    // Captured during Init — Alchemy binds these onto the Worker and the
    // runtime ConfigProvider (backed by `env`) re-resolves them here.
    const configStr = yield* Config.string("CONFIG_STR");
    const configNum = yield* Config.number("CONFIG_NUM");
    const configRedactedInit = yield* Config.redacted("CONFIG_REDACTED_INIT");

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const env = yield* Cloudflare.WorkerEnvironment;
        const pathname = new URL(request.originalUrl).pathname;

        if (pathname === "/env") {
          return yield* HttpServerResponse.json({
            STR: env.STR,
            NUM: env.NUM,
            BOOL: env.BOOL,
            NULL: env.NULL,
            OBJ: env.OBJ,
            ARR: env.ARR,
            SECRET_STR: env.SECRET_STR,
            SECRET_JSON:
              typeof env.SECRET_JSON === "string"
                ? JSON.parse(env.SECRET_JSON)
                : env.SECRET_JSON,
          });
        }

        if (pathname === "/config") {
          return yield* HttpServerResponse.json({
            CONFIG_STR: configStr,
            CONFIG_NUM: configNum,
            CONFIG_REDACTED: env.CONFIG_REDACTED,
            CONFIG_REDACTED_INIT: Redacted.value(configRedactedInit),
            CONFIG_REDACTED_INIT_IS_REDACTED:
              Redacted.isRedacted(configRedactedInit),
          });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}

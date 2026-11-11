import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectUrlContains } from "../Utils/Http.ts";
import EnvEffectWorker from "./fixtures/env/effect.ts";

// Deploy-time `Config` reads in the fixture's Init must resolve.
process.env.CONFIG_STR ??= "config-string-value";
process.env.CONFIG_NUM ??= "1234";
process.env.CONFIG_REDACTED ??= "config-redacted-value";
process.env.CONFIG_REDACTED_INIT ??= "config-redacted-init-value";
process.env.CONFIG_NESTED_HOST ??= "config-nested-host-value";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "local effect worker reads env strings that parse as JSON as strings (#2847)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const worker = yield* stack.deploy(EnvEffectWorker);
      expect(worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const body = yield* expectUrlContains(`${worker.url}/json-strings`, '"PLAIN"', {
        timeout: "60 seconds",
        label: "local effect env-worker /json-strings",
      });
      const strings = {
        JSON_FALSE: "false",
        JSON_NUM: "42",
        JSON_NULL: "null",
        JSON_OBJ: '{"a":1}',
        PLAIN: "my-queue",
      };
      expect(JSON.parse(body)).toEqual({
        init: { ...strings, JSON_FALSE_BOOL: false },
        runtime: { ...strings, JSON_FALSE_BOOL: false },
        env: strings,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);

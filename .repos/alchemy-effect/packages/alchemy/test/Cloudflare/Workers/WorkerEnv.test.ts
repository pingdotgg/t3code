import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/env/stack.ts";

// Populate process.env before deploy so the worker fixture's
// `Config.xxx(...)` reads resolve at deploy time (default provider).
const CONFIG_STR_VALUE = (process.env.CONFIG_STR = "config-string-value");
const CONFIG_NUM_VALUE = (process.env.CONFIG_NUM = "1234");
const CONFIG_REDACTED_VALUE = (process.env.CONFIG_REDACTED =
  "config-redacted-value");
const CONFIG_REDACTED_INIT_VALUE = (process.env.CONFIG_REDACTED_INIT =
  "config-redacted-init-value");
// Read via `Config.string("HOST").pipe(Config.nested("CONFIG_NESTED"))` —
// binds under the flattened `CONFIG_NESTED_HOST` key.
const CONFIG_NESTED_HOST_VALUE = (process.env.CONFIG_NESTED_HOST =
  "config-nested-host-value");

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

describe.concurrent("Cloudflare.Worker env bindings", () => {
  test(
    "async worker round-trips every supported binding shape",
    Effect.gen(function* () {
      const { asyncUrl } = yield* stack;
      expect(asyncUrl).toBeTypeOf("string");
      yield* Effect.log(asyncUrl);

      const body = yield* expectUrlContains(asyncUrl, '"STR":"hello"', {
        timeout: "60 seconds",
        label: "async env-worker response",
      });
      expect(JSON.parse(body)).toEqual({
        STR: "hello",
        NUM: 42,
        BOOL: true,
        NULL: null,
        OBJ: { nested: { value: "ok" }, count: 7 },
        ARR: [1, 2, 3],
        OUTPUT_STR: "output-str",
        SECRET_STR: "shh",
        SECRET_JSON: { token: "abc", scopes: ["read", "write"] },
        CONFIG_STR: CONFIG_STR_VALUE,
        CONFIG_NUM: Number(CONFIG_NUM_VALUE),
        CONFIG_REDACTED: CONFIG_REDACTED_VALUE,
        VERSION_METADATA: {
          id: expect.any(String),
          tag: expect.any(String),
          timestamp: expect.any(String),
        },
      });
    }).pipe(logLevel),
  );

  test(
    "effect worker round-trips env: literals and Redacted via WorkerEnvironment",
    Effect.gen(function* () {
      const { effectUrl } = yield* stack;

      const body = yield* expectUrlContains(
        `${effectUrl}/env`,
        '"STR":"hello"',
        { timeout: "60 seconds", label: "effect env-worker /env" },
      );
      expect(JSON.parse(body)).toEqual({
        STR: "hello",
        NUM: 42,
        BOOL: true,
        NULL: null,
        OBJ: { nested: { value: "ok" }, count: 7 },
        ARR: [1, 2, 3],
        OUTPUT_STR: "output-str",
        SECRET_STR: "shh",
        SECRET_JSON: { token: "abc", scopes: ["read", "write"] },
      });
    }).pipe(logLevel),
  );

  test(
    "effect worker resolves the yielded VersionMetadata binding",
    Effect.gen(function* () {
      const { effectUrl } = yield* stack;

      const body = yield* expectUrlContains(`${effectUrl}/version`, '"id"', {
        timeout: "60 seconds",
        label: "effect env-worker /version",
      });
      expect(JSON.parse(body)).toEqual({
        id: expect.any(String),
        tag: expect.any(String),
        timestamp: expect.any(String),
      });
    }).pipe(logLevel),
  );

  test(
    "effect worker re-resolves Config.xxx at request time inside a nested effect",
    Effect.gen(function* () {
      const { effectUrl } = yield* stack;

      const body = yield* expectUrlContains(
        `${effectUrl}/config-runtime`,
        '"CONFIG_STR"',
        { timeout: "60 seconds", label: "effect env-worker /config-runtime" },
      );
      expect(JSON.parse(body)).toEqual({
        CONFIG_STR: CONFIG_STR_VALUE,
        CONFIG_NUM: Number(CONFIG_NUM_VALUE),
        CONFIG_NUM_WITH_DEFAULT: Number(CONFIG_NUM_VALUE),
        CONFIG_UNSET_WITH_DEFAULT: 3000,
        CONFIG_REDACTED_INIT: CONFIG_REDACTED_INIT_VALUE,
        CONFIG_REDACTED_INIT_IS_REDACTED: true,
        CONFIG_ALL_OBJ: {
          str: CONFIG_STR_VALUE,
          num: Number(CONFIG_NUM_VALUE),
          redacted: CONFIG_REDACTED_INIT_VALUE,
          redactedIsRedacted: true,
        },
        CONFIG_ALL_TUPLE: [CONFIG_STR_VALUE, Number(CONFIG_NUM_VALUE)],
        CONFIG_NESTED_HOST: CONFIG_NESTED_HOST_VALUE,
      });
    }).pipe(logLevel),
  );

  test(
    "effect worker round-trips Config.xxx bindings captured in Init",
    Effect.gen(function* () {
      const { effectUrl } = yield* stack;

      const body = yield* expectUrlContains(
        `${effectUrl}/config`,
        '"CONFIG_STR"',
        { timeout: "60 seconds", label: "effect env-worker /config" },
      );
      expect(JSON.parse(body)).toEqual({
        CONFIG_STR: CONFIG_STR_VALUE,
        CONFIG_NUM: Number(CONFIG_NUM_VALUE),
        CONFIG_REDACTED: CONFIG_REDACTED_VALUE,
        CONFIG_REDACTED_INIT: CONFIG_REDACTED_INIT_VALUE,
        CONFIG_REDACTED_INIT_IS_REDACTED: true,
        CONFIG_ALL_OBJ: {
          str: CONFIG_STR_VALUE,
          num: Number(CONFIG_NUM_VALUE),
          redacted: CONFIG_REDACTED_INIT_VALUE,
          redactedIsRedacted: true,
        },
        CONFIG_ALL_TUPLE: [CONFIG_STR_VALUE, Number(CONFIG_NUM_VALUE)],
        CONFIG_NESTED_HOST: CONFIG_NESTED_HOST_VALUE,
      });
    }).pipe(logLevel),
  );
});

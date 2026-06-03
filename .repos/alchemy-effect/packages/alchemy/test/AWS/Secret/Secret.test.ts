import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as State from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SecretsTestFunctionLive, {
  CONFIG_SECRET_ENV_KEY,
  LITERAL_SECRET_VALUE,
  NUMBER_VAR_VALUE,
  OBJECT_VAR_VALUE,
  STRING_VAR_VALUE,
  SecretsTestFunction,
} from "./fixtures/handler.ts";

/**
 * `Config.redacted("CONFIG_SECRET")` resolves against the active
 * `ConfigProvider` at deploy time. The default provider reads from
 * `process.env`, so populate it before `beforeAll(deploy(Stack))`
 * compiles the stack.
 */
const CONFIG_SECRET_VALUE = "sk-from-aws-config-source-xyz";
process.env[CONFIG_SECRET_ENV_KEY] = CONFIG_SECRET_VALUE;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "AlchemySecretLambdaStack",
  {
    providers: AWS.providers(),
    state: State.localState(),
  },
  Effect.gen(function* () {
    const fn = yield* SecretsTestFunction;
    return {
      url: fn.functionUrl.as<string>(),
    };
  }).pipe(Effect.provide(SecretsTestFunctionLive)),
);

const stack = beforeAll(deploy(Stack), { timeout: 90_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 60_000 });

// Lambda Function URLs cold-start (DNS, IAM propagation, init) can take
// well over a minute on a fresh deploy under parallel load. Budget a
// generous retry window for the very first request, then reuse the
// warm URL for subsequent calls.
const readinessSchedule = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(20)),
);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.flatMap(res.json, (body) => Effect.succeed(body))
        : Effect.fail(new Error(`Request failed: ${res.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

test(
  "Config.redacted with literal default round-trips to Lambda runtime as Redacted<string>",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");

    const baseUrl = url.replace(/\/+$/, "");
    const body = (yield* getJson(`${baseUrl}/secret/literal`)) as {
      isRedacted: boolean;
      value: string;
    };
    expect(body).toEqual({
      isRedacted: true,
      value: LITERAL_SECRET_VALUE,
    });
  }).pipe(logLevel),
  { timeout: 45_000 },
);

test(
  "Config.redacted resolved from env round-trips through Lambda env",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    const body = (yield* getJson(`${baseUrl}/secret/config`)) as {
      isRedacted: boolean;
      value: string;
    };
    expect(body).toEqual({
      isRedacted: true,
      value: CONFIG_SECRET_VALUE,
    });
  }).pipe(logLevel),
  { timeout: 45_000 },
);

test(
  "Config.string round-trips to Lambda runtime as a string",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    const body = (yield* getJson(`${baseUrl}/var/string`)) as {
      type: string;
      value: unknown;
    };
    expect(body).toEqual({ type: "string", value: STRING_VAR_VALUE });
  }).pipe(logLevel),
  { timeout: 45_000 },
);

test(
  "Config.number round-trips to Lambda runtime preserving the number type",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    const body = (yield* getJson(`${baseUrl}/var/number`)) as {
      type: string;
      value: unknown;
    };
    expect(body).toEqual({ type: "number", value: NUMBER_VAR_VALUE });
  }).pipe(logLevel),
  { timeout: 45_000 },
);

test(
  "Config.string with object default round-trips to Lambda runtime preserving nested shape",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");

    const body = (yield* getJson(`${baseUrl}/var/object`)) as {
      type: string;
      value: unknown;
    };
    expect(body).toEqual({ type: "object", value: OBJECT_VAR_VALUE });
  }).pipe(logLevel),
  { timeout: 45_000 },
);

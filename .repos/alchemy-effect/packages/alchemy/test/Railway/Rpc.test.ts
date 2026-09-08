import * as Railway from "@/Railway";
import { RPC_PATH_PREFIX, RPC_TOKEN_HEADER } from "@/Railway/rpc-token.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Api, ApiLive } from "./fixtures/rpc-api.ts";
import Caller from "./fixtures/rpc-caller.ts";
import Greeter from "./fixtures/rpc-greeter.ts";
import Query from "./fixtures/rpc-query.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body?: string;
}> {
  override get message() {
    return this.body === undefined
      ? `status ${this.status}`
      : `status ${this.status}: ${this.body}`;
  }
}

const getText = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.timeout("15 seconds"),
      Effect.flatMap((res) =>
        res.status === 200
          ? res.text
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new NotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        schedule: Schedule.spaced("4 seconds"),
        times: 20,
      }),
    );
  });

test.provider.skip(
  "Function-to-Function schemaless RPC stays on the private mesh (canvas start command max 96KB)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const greeter = yield* Greeter;
          const caller = yield* Caller;
          return { greeter, caller };
        }),
      );

      expect(created.greeter.dnsName).toEqual(
        `${created.greeter.name}.railway.internal`,
      );
      expect(created.greeter.dnsName.endsWith(".railway.internal")).toEqual(
        true,
      );
      expect(created.greeter.rpcToken.length).toBeGreaterThanOrEqual(32);
      expect(created.greeter.url).toEqual(expect.any(String));
      expect(created.caller.url).toEqual(expect.any(String));

      const greeterPublic = yield* getText(created.greeter.url!);
      expect(greeterPublic).toEqual("greeter");

      const client = yield* HttpClient.HttpClient;
      const publicRpc = yield* client.execute(
        HttpClientRequest.post(
          `${created.greeter.url}${RPC_PATH_PREFIX}greet`,
        ).pipe(
          HttpClientRequest.bodyText(
            JSON.stringify(["sam"]),
            "application/json",
          ),
          HttpClientRequest.setHeader(
            RPC_TOKEN_HEADER,
            created.greeter.rpcToken,
          ),
        ),
      );
      expect(publicRpc.status).toEqual(401);

      const greeting = yield* getText(created.caller.url!);
      expect(greeting).toEqual("hello sam");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

test.provider.skip(
  "Service and Function bind each other in tagged form over the private mesh (canvas start command max 96KB)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const query = yield* Query;
          const api = yield* Api;
          return { query, api };
        }).pipe(Effect.provide(ApiLive)),
      );

      expect(created.query.url).toEqual(expect.any(String));
      expect(created.api.url).toEqual(expect.any(String));

      yield* Effect.log(
        `tagged rpc urls query=${created.query.url} api=${created.api.url}`,
      );

      // Probe the Service origin first (Docker). The Function canvas
      // used to hang GET `/` while this side was already serving.
      const fromService = yield* getText(created.api.url!);
      expect(fromService).toEqual("api");

      const fromFunction = yield* getText(created.query.url!);
      expect(fromFunction).toEqual("query");

      const viaFunction = yield* getText(`${created.query.url}/pong`);
      expect(viaFunction).toEqual("pong");

      const viaService = yield* getText(`${created.api.url}/hello`);
      expect(viaService).toEqual("hello sam");

      const client = yield* HttpClient.HttpClient;
      const functionRpc = yield* client.execute(
        HttpClientRequest.post(
          `${created.query.url}${RPC_PATH_PREFIX}greet`,
        ).pipe(
          HttpClientRequest.bodyText(
            JSON.stringify(["sam"]),
            "application/json",
          ),
          HttpClientRequest.setHeader(RPC_TOKEN_HEADER, created.query.rpcToken),
        ),
      );
      expect(functionRpc.status).toEqual(401);

      const serviceRpc = yield* client.execute(
        HttpClientRequest.post(`${created.api.url}${RPC_PATH_PREFIX}ping`).pipe(
          HttpClientRequest.bodyText("[]", "application/json"),
          HttpClientRequest.setHeader(RPC_TOKEN_HEADER, created.api.rpcToken),
        ),
      );
      expect(serviceRpc.status).toEqual(401);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

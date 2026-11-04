import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import RestArgsCaller from "./fixtures/rpc-rest-args/caller.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const hostMain = pathe.resolve(import.meta.dirname, "fixtures/rpc-rest-args/host.ts");

const restArgsHost = () =>
  Cloudflare.Worker("RestArgsHost", {
    main: hostMain,
    env: { REST_ARGS: Cloudflare.DurableObject("RestArgs") },
  });

describe(
  "Durable Object RPC arguments",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test.provider(
      "a plain-JS Durable Object method receives exactly the caller's arguments",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // The caller binds the host's class by script name, so the host
          // deploys first.
          const host = yield* stack.deploy(restArgsHost());
          const currentConfig = yield* ConfigProvider.ConfigProvider;
          const caller = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* restArgsHost();
                return yield* RestArgsCaller;
              }),
            )
            .pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.orElse(
                  ConfigProvider.fromUnknown({ REST_ARGS_HOST: host.workerName }),
                  currentConfig,
                ),
              ),
            );

          // The caller calls inside a span; a trace context appended to the
          // call would show up as a third argument.
          const url = caller.url as string;
          yield* expectUrlContains(url, '"args":', {
            timeout: "180 seconds",
            label: "caller reaches the plain-JS Durable Object",
          });
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(url);
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual({ args: ["a", "b"] });

          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );
  },
);

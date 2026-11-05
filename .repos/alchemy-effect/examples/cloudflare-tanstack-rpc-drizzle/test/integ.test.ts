import { describe, expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Neon from "@alchemy.run/neon";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { TodoRpcs } from "../src/backend/rpc.ts";

describe.each([true, false])("CloudflareTanstackRpcDrizzleExample (dev: %p)", (dev) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers(), Neon.providers()),
    state: Alchemy.localState(),
    dev,
  });

  const stack = beforeAll(
    deploy(Stack).pipe(
      Effect.tap((stack) =>
        // Fresh workers.dev URLs take a few seconds to start answering, so
        // fetch with retries until it's ready before we exercise it in tests.
        // Note that the response here will be the RPC server complaining that the
        // request is invalid since we're not actually making an RPC call here.
        // `filterStatusOk` works because Effect RPC still returns 200, but we may
        // need to update this if/when Effect RPC changes its behavior.
        HttpClient.get(new URL("/rpc", stack.websiteUrl)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.retry({
            schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.recurs(20)]),
          }),
        ),
      ),
    ),
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

  const RpcProtocol = stack.pipe(
    Effect.map(({ websiteUrl }) =>
      RpcClient.layerProtocolHttp({
        url: new URL("/rpc", websiteUrl).toString(),
      }),
    ),
    Layer.unwrap,
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerJson),
  );

  test(
    "deploys and exposes urls + db identifiers",
    Effect.gen(function* () {
      const { websiteUrl, branchId, hyperdriveId } = yield* stack;
      expect(websiteUrl).toBeString();
      expect(branchId).toBeString();
      expect(hyperdriveId).toBeString();
    }),
  );

  test(
    "todo CRUD round-trips through the /rpc proxy into Drizzle/Neon",
    Effect.gen(function* () {
      const client = yield* RpcClient.make(TodoRpcs);

      const created = yield* client.createTodo({ text: "write the example" });
      expect(created.id).toBeNumber();
      expect(created.text).toBe("write the example");
      expect(created.done).toBe(false);

      const afterCreate = yield* client.listTodos();
      expect(afterCreate.some((t) => t.id === created.id)).toBe(true);

      const toggled = yield* client.toggleTodo({
        id: created.id,
        done: true,
      });
      expect(toggled.done).toBe(true);

      const deletedId = yield* client.deleteTodo({ id: created.id });
      expect(deletedId).toBe(created.id);

      const afterDelete = yield* client.listTodos();
      expect(afterDelete.some((t) => t.id === created.id)).toBe(false);
    }).pipe(Effect.provide(RpcProtocol)),
  );

  test(
    "toggling a missing todo fails with TodoNotFound",
    Effect.gen(function* () {
      const client = yield* RpcClient.make(TodoRpcs);
      const result = yield* client.toggleTodo({ id: 2_147_483_000, done: true }).pipe(Effect.flip);
      expect(result._tag).toBe("TodoNotFound");
    }).pipe(Effect.provide(RpcProtocol)),
  );
});

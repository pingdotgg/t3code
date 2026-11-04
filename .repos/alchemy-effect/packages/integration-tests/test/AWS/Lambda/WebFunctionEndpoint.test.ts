import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import EffectWebFunctionLive, { EffectWebFunction } from "./fixtures/web/effect-web.ts";

const asyncServerMain = fileURLToPath(new URL("./fixtures/web/async-server.ts", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:lambda", "live"];

class UnexpectedStatus extends Error {}

/** GET `url` until it answers 200 with a body satisfying `until`. */
const getTextUntil = (url: string, until: (body: string) => boolean = () => true) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text
        : Effect.fail(new UnexpectedStatus(`${url} returned ${response.status}`)),
    ),
    Effect.retry({ schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]) }),
    Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until, times: 30 }),
  );

const listEndpointNames = (functionName: string) =>
  LambdaWeb.listWebFunctionEndpoints({ functionName }).pipe(
    Effect.map((r) => r.endpoints.map((e) => e.endpointName).sort()),
  );

test.provider(
  "additional endpoint: create, follow revisions, update, rename, remove",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (options: {
        greeting: string;
        webhooks?: Partial<AWS.Lambda.WebFunctionEndpointProps>;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const api = yield* AWS.Lambda.WebFunction("Doors", {
              main: asyncServerMain,
              authType: "ApplicationManaged",
              env: { GREETING: options.greeting },
            });
            const webhooks = options.webhooks
              ? yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
                  function: api,
                  authType: "ApplicationManaged",
                  ...options.webhooks,
                })
              : undefined;
            return { api, webhooks };
          }),
        );

      // Create: two doors onto the same code, told apart by the header.
      const created = yield* deploy({ greeting: "one", webhooks: { rateLimit: 100 } });
      const api = created.api;
      const webhooks = created.webhooks!;
      expect(webhooks.url).not.toBe(api.url);
      expect(webhooks.endpointName).toBe("Webhooks");
      expect(webhooks.revisionId).toBe(api.revisionId);
      expect(yield* getTextUntil(`${api.url}/endpoint`)).toBe("default");
      expect(yield* getTextUntil(`${webhooks.url}/endpoint`)).toBe("Webhooks");
      expect(yield* listEndpointNames(api.functionName)).toEqual(["Webhooks", "default"]);
      const observed = yield* LambdaWeb.getWebFunctionEndpoint({
        functionName: api.functionName,
        endpointName: "Webhooks",
      });
      expect(observed.throttleConfig?.rateLimit).toBe(100);
      expect(observed.revisionWeights).toEqual([{ revisionId: api.revisionId, weight: 100 }]);

      // A new revision moves both doors; the endpoint updates in place.
      const updated = yield* deploy({ greeting: "two", webhooks: { rateLimit: 200 } });
      expect(updated.api.revisionId).not.toBe(api.revisionId);
      expect(updated.webhooks!.url).toBe(webhooks.url);
      expect(updated.webhooks!.revisionId).toBe(updated.api.revisionId);
      expect(yield* getTextUntil(webhooks.url, (body) => body === "greeting=two")).toBe(
        "greeting=two",
      );
      const updatedObserved = yield* LambdaWeb.getWebFunctionEndpoint({
        functionName: api.functionName,
        endpointName: "Webhooks",
      });
      expect(updatedObserved.throttleConfig?.rateLimit).toBe(200);

      // Renaming is a new endpoint with a new URL; the old one is removed.
      const renamed = yield* deploy({ greeting: "two", webhooks: { endpointName: "hooks" } });
      expect(renamed.webhooks!.endpointName).toBe("hooks");
      expect(renamed.webhooks!.url).not.toBe(webhooks.url);
      expect(yield* listEndpointNames(api.functionName)).toEqual(["default", "hooks"]);
      expect(yield* getTextUntil(`${renamed.webhooks!.url}/endpoint`)).toBe("hooks");

      // Removing the resource removes only that endpoint.
      const removed = yield* deploy({ greeting: "two" });
      expect(removed.api.url).toBe(api.url);
      expect(yield* listEndpointNames(api.functionName)).toEqual(["default"]);

      // Endpoint type and Regions are immutable: changing them replaces it.
      yield* deploy({ greeting: "two", webhooks: {} });
      const multiRegion = yield* stack.plan(
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.WebFunction("Doors", {
            main: asyncServerMain,
            authType: "ApplicationManaged",
            env: { GREETING: "two" },
          });
          return yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
            function: fn,
            authType: "ApplicationManaged",
            regions: ["us-east-1"],
          });
        }),
      );
      expect(multiRegion.resources.Webhooks).toMatchObject({ action: "replace" });

      yield* stack.destroy();
      const gone = yield* LambdaWeb.getWebFunction({ functionName: api.functionName }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 360_000 },
);

test.provider(
  "takes a class-form WebFunction directly",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { api, webhooks } = yield* stack.deploy(
        Effect.gen(function* () {
          const webhooks = yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
            // the class declaration itself, not a yielded instance
            function: EffectWebFunction,
            authType: "ApplicationManaged",
          });
          const api = yield* EffectWebFunction;
          return { api, webhooks };
        }).pipe(Effect.provide(EffectWebFunctionLive)),
      );
      expect(webhooks.functionName).toBe(api.functionName);
      expect(webhooks.revisionId).toBe(api.revisionId);
      expect(yield* getTextUntil(webhooks.url)).toBe("hello from effect");

      yield* stack.destroy();
      expect(
        yield* listEndpointNames(api.functionName).pipe(Effect.orElseSucceed(() => [])),
      ).toEqual([]);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 240_000 },
);

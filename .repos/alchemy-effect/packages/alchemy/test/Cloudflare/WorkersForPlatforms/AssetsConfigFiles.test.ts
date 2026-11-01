import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import {
  expectUrlContains,
  expectUrlHeader,
  expectUrlRedirect,
} from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });
const directory = pathe.resolve(import.meta.dirname, "fixtures/assets-config");

// Regression for distilled#647: dispatch uploads must serialize asset rules
// as assets.config._headers / _redirects, just like ordinary Worker uploads.
test.provider.skipIf(process.env.CLOUDFLARE_TEST_WFP === "0")(
  "dispatch asset headers and redirects survive keep-assets updates",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (marker: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const namespace =
              yield* Cloudflare.WorkersForPlatforms.DispatchNamespace(
                "AssetsConfigNamespace",
                {},
              );
            const worker = yield* Cloudflare.Worker("AssetsConfigUser", {
              namespace: namespace.name,
              script: `export default { fetch: () => new Response(${JSON.stringify(marker)}) };`,
              assets: { directory, hash: "wfp-assets-config-v1" },
            });
            const dispatcher = yield* Cloudflare.Worker(
              "AssetsConfigDispatcher",
              {
                workersDev: true,
                env: { DISPATCH: namespace, USER_SCRIPT: worker.workerName },
                script: `export default {
                fetch(request, env) {
                  return env.DISPATCH.get(env.USER_SCRIPT).fetch(request);
                }
              };`,
              },
            );
            return { namespace, worker, dispatcher };
          }),
        );

      const initial = yield* deploy("wfp-assets-worker-v1");
      const url = initial.dispatcher.url!;
      yield* expectUrlContains(`${url}/`, "alchemy-wfp-assets-config", {
        timeout: "15 seconds",
      });
      yield* expectUrlHeader(
        `${url}/`,
        "cache-control",
        "public, max-age=3600",
        {
          timeout: "15 seconds",
        },
      );
      yield* expectUrlRedirect(`${url}/old-path`, "/index.html", {
        status: 301,
        timeout: "15 seconds",
      });

      const live = yield* wfp
        .getDispatchNamespaceScript({
          accountId: initial.namespace.accountId,
          dispatchNamespace: initial.namespace.name,
          scriptName: initial.worker.workerName,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Forbidden" ||
              error._tag === "DispatchNamespaceScriptNotFound",
            schedule: Schedule.fixed("1 second"),
            times: 8,
          }),
        );
      expect(live.script?.hasAssets).toBe(true);

      // The unchanged asset hash skips upload; changing the script still
      // performs a PUT, which must resend the header and redirect rules.
      yield* deploy("wfp-assets-worker-v2");
      yield* expectUrlContains(`${url}/worker-route`, "wfp-assets-worker-v2", {
        timeout: "15 seconds",
      });
      yield* expectUrlHeader(
        `${url}/`,
        "cache-control",
        "public, max-age=3600",
        {
          timeout: "15 seconds",
        },
      );
      yield* expectUrlRedirect(`${url}/old-path`, "/index.html", {
        status: 301,
        timeout: "15 seconds",
      });

      yield* stack.destroy();
      yield* wfp
        .getDispatchNamespace({
          accountId: initial.namespace.accountId,
          dispatchNamespace: initial.namespace.name,
        })
        .pipe(
          Effect.flatMap(() =>
            Effect.fail({ _tag: "NamespaceStillExists" } as const),
          ),
          Effect.catchTag("DispatchNamespaceNotFound", () => Effect.void),
          Effect.retry({
            while: (error) =>
              error._tag === "NamespaceStillExists" ||
              error._tag === "Forbidden",
            schedule: Schedule.fixed("1 second"),
            times: 8,
          }),
        );
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workersforplatforms",
      "live",
    ],
    timeout: 120_000,
  },
);

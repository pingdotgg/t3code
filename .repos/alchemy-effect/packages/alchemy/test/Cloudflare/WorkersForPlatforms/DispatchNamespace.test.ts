import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import { poll } from "@/Util/poll.ts";
import * as Test from "@/Test/Alchemy";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getNamespace = (accountId: string, name: string) =>
  wfp.getDispatchNamespace({ accountId, dispatchNamespace: name }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A missing namespace surfaces as `DispatchNamespaceNotFound`
// (Cloudflare error code 100119) — that's the success condition here.
const expectNamespaceGone = (accountId: string, name: string) =>
  getNamespace(accountId, name).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "NamespaceNotDeleted" } as const)),
    Effect.catchTag("DispatchNamespaceNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "NamespaceNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const getScript = (accountId: string, namespace: string, scriptName: string) =>
  wfp
    .getDispatchNamespaceScript({
      accountId,
      dispatchNamespace: namespace,
      scriptName,
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );

// A deleted script comes back as a success with `script: null` while its
// namespace still exists, and as `DispatchNamespaceNotFound` once the
// namespace itself has been destroyed — both are the success condition.
const expectScriptGone = (
  accountId: string,
  namespace: string,
  scriptName: string,
) =>
  getScript(accountId, namespace, scriptName).pipe(
    Effect.flatMap((response) =>
      response.script
        ? Effect.fail({ _tag: "ScriptNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.catchTag(
      ["DispatchNamespaceNotFound", "DispatchNamespaceScriptNotFound"],
      () => Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "ScriptNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, replace, and destroy a dispatch namespace",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const namespace = yield* stack.deploy(
        Cloudflare.WorkersForPlatforms.DispatchNamespace("Namespace", {
          name: "alchemy-wfp-test-ns",
        }),
      );

      expect(namespace.namespaceId).toBeTruthy();
      expect(namespace.name).toEqual("alchemy-wfp-test-ns");
      expect(namespace.accountId).toEqual(accountId);
      expect(namespace.scriptCount).toEqual(0);

      // Read-after-create: a brand-new namespace can briefly 404 from the
      // out-of-band read under load — ride that out before asserting.
      const live = yield* getNamespace(accountId, "alchemy-wfp-test-ns").pipe(
        Effect.retry({
          while: (e) => e._tag === "DispatchNamespaceNotFound",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
      expect(live.namespaceName).toEqual("alchemy-wfp-test-ns");
      expect(live.namespaceId).toEqual(namespace.namespaceId);

      // The name is the namespace's identity — changing it must replace.
      const replaced = yield* stack.deploy(
        Cloudflare.WorkersForPlatforms.DispatchNamespace("Namespace", {
          name: "alchemy-wfp-test-ns-v2",
        }),
      );
      expect(replaced.namespaceId).not.toEqual(namespace.namespaceId);
      expect(replaced.name).toEqual("alchemy-wfp-test-ns-v2");
      yield* expectNamespaceGone(accountId, "alchemy-wfp-test-ns");

      yield* stack.destroy();

      yield* expectNamespaceGone(accountId, "alchemy-wfp-test-ns-v2");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const namespaceName = "alchemy-wfp-test-script-ns";
const scriptName = "alchemy-wfp-customer-a";

// One program deploying the namespace and a user script into it. The
// script's props reference the namespace's output name, so the engine
// orders script-last on deploy (and first on destroy).
const program = () =>
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace(
      "ScriptNs",
      {
        name: namespaceName,
      },
    );

    return { namespace };
  });

test.provider(
  "upload, update in place, and destroy a namespace script",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(program());

      // Changing the module body re-uploads in place — same identity,
      // new etag.
      const updated = yield* stack.deploy(program());

      expect(updated.namespace.namespaceId).toEqual(
        initial.namespace.namespaceId,
      );

      yield* stack.destroy();

      yield* expectScriptGone(accountId, namespaceName, scriptName);
      yield* expectNamespaceGone(accountId, namespaceName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed dispatch namespace",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.WorkersForPlatforms.DispatchNamespace("ListNs", {
          name: "alchemy-wfp-test-list-ns",
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.WorkersForPlatforms.DispatchNamespace,
      );

      // A just-created namespace can lag the account-wide list under load —
      // poll until it shows up (bounded) instead of asserting immediately.
      const all = yield* poll({
        description: "list() includes the deployed dispatch namespace",
        effect: provider.list(),
        predicate: (all) =>
          all.some((ns) => ns.namespaceId === deployed.namespaceId),
        schedule: Schedule.max([
          Schedule.spaced("2 seconds"),
          Schedule.recurs(20),
        ]),
      });

      const match = all.find((ns) => ns.namespaceId === deployed.namespaceId);
      expect(match).toBeDefined();
      expect(match?.name).toEqual("alchemy-wfp-test-list-ns");
      expect(match?.accountId).toEqual(accountId);

      yield* stack.destroy();

      yield* expectNamespaceGone(accountId, "alchemy-wfp-test-list-ns");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

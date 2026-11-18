import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { encodeDurableObjectTags } from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../../names.ts";

/**
 * Upgrading a Worker that an earlier Alchemy release deployed with
 * Cloudflare's legacy `migrations` flow to the declarative `exports` flow.
 *
 * Each case first recreates the earlier release's deploy through the
 * Workers API — the same `migrations` upload and the same ownership and
 * `alchemy:dos:` tags — then deploys the same stack, stage and logical id
 * with the current provider, which is the upgrade a user runs.
 */
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// A pooled keep-alive connection stays pinned to one edge metal, which can
// keep serving the previous version; close each connection so retries can
// reach a metal with the new version.
const freshConn = HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close"));

const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        Effect.flatMap(r.text, (body) =>
          r.status !== 200
            ? Effect.fail(new Error(`not ready at ${url}: ${r.status} ${body.slice(0, 300)}`))
            : body.includes(DEPLOY_PLACEHOLDER)
              ? Effect.fail(new Error("still deploying"))
              : Effect.try({
                  try: () => JSON.parse(body) as T,
                  catch: () => new Error(`non-json body: ${body.slice(0, 300)}`),
                }),
        ),
      ),
      Effect.retry({ schedule: readinessSchedule, times: 15 }),
    );
  });

/** A Worker hosting the given Durable Object classes; `Counter` (or the first class) stores a count. */
const hostScript = (
  classes: string[],
  counterBinding = "Counter",
) => `import { DurableObject } from "cloudflare:workers";
${classes
  .map(
    (c) => `export class ${c} extends DurableObject {
  async increment() {
    const value = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", value);
    return value;
  }
  async get() {
    return (await this.ctx.storage.get("count")) ?? 0;
  }
}`,
  )
  .join("\n")}
export default {
  async fetch(request, env) {
    const stub = env.${counterBinding}.getByName("shared");
    const url = new URL(request.url);
    if (url.pathname === "/increment") return Response.json({ value: await stub.increment() });
    return Response.json({ value: await stub.get() });
  },
};
`;

type Scratch = { name: string; stage: string };

/**
 * A deterministic per-stage script name, short enough for workers.dev
 * previews (54 characters) under any stage.
 */
const scriptNameFor = (_scratch: Scratch, suffix: string) =>
  testName(`alchemy-test-upgrade-${suffix}`);

/**
 * Deploy a Worker the way an earlier Alchemy release did: a `migrations`
 * upload carrying the stack ownership tags and the packed `alchemy:dos:`
 * mapping, with its workers.dev URL enabled.
 */
const deployWithMigrations = Effect.fn(function* (params: {
  scratch: Scratch;
  /** Owning stack, when it is not the test's own (a cross-stack former host). */
  stackName?: string;
  logicalId: string;
  scriptName: string;
  script: string;
  bindings: { logicalId: string; className: string }[];
  migrations: workers.PutScriptRequest["metadata"]["migrations"];
}) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  yield* workers.putScript({
    accountId,
    scriptName: params.scriptName,
    metadata: {
      mainModule: "main.js",
      compatibilityDate: "2026-08-31",
      bindings: params.bindings.map((b) => ({
        type: "durable_object_namespace",
        name: b.logicalId,
        className: b.className,
      })),
      migrations: params.migrations,
      tags: [
        `alchemy:stack:${params.stackName ?? params.scratch.name}`,
        `alchemy:stage:${params.scratch.stage}`,
        `alchemy:id:${params.logicalId}`,
        ...encodeDurableObjectTags(params.bindings),
      ],
    },
    files: [new File([params.script], "main.js", { type: "application/javascript+module" })],
  });
  yield* workers.createScriptSubdomain({ accountId, scriptName: params.scriptName, enabled: true });
  const { subdomain } = yield* workers.getSubdomain({ accountId });
  return `https://${params.scriptName}.${subdomain}.workers.dev`;
});

/**
 * Deploy a Worker the way Wrangler does with declarative `exports`: no
 * `migrations` and no Alchemy tags, with its workers.dev URL enabled.
 */
const deployWithExports = Effect.fn(function* (params: {
  scriptName: string;
  script: string;
  bindings: string[];
  exports: workers.PutScriptRequest["metadata"]["exports"];
}) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  yield* workers.putScript({
    accountId,
    scriptName: params.scriptName,
    metadata: {
      mainModule: "main.js",
      compatibilityDate: "2026-08-31",
      bindings: params.bindings.map((className) => ({
        type: "durable_object_namespace",
        name: className,
        className,
      })),
      exports: params.exports,
    },
    files: [new File([params.script], "main.js", { type: "application/javascript+module" })],
  });
  yield* workers.createScriptSubdomain({ accountId, scriptName: params.scriptName, enabled: true });
  const { subdomain } = yield* workers.getSubdomain({ accountId });
  return `https://${params.scriptName}.${subdomain}.workers.dev`;
});

const deleteScript = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  yield* workers
    .deleteScript({ accountId, scriptName, force: true })
    .pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
});

/**
 * The script's Durable Object namespaces as `{ className: namespaceId }`,
 * in the account (default) or in a dispatch namespace.
 */
const namespacesOf = Effect.fn(function* (scriptName: string, dispatchNamespace?: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const namespaces = yield* durableObjects.listNamespaces.items({ accountId }).pipe(
    Stream.filter(
      (ns) => ns.script === scriptName && (ns.dispatchNamespace ?? undefined) === dispatchNamespace,
    ),
    Stream.runCollect,
  );
  return Object.fromEntries(Array.from(namespaces).map((ns) => [ns.class, ns.id]));
});

/**
 * The state a transfer leaves behind when the deploy dies after its first
 * step: the new host declares the class `expecting-transfer`, without the
 * binding or the `alchemy:dos:` entry for it.
 */
const stageTransfer = Effect.fn(function* (params: {
  scratch: Scratch;
  logicalId: string;
  scriptName: string;
  fromScript: string;
  className: string;
}) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  yield* workers.putScript({
    accountId,
    scriptName: params.scriptName,
    metadata: {
      mainModule: "main.js",
      compatibilityDate: "2026-08-31",
      exports: {
        [params.className]: {
          type: "durable-object",
          storage: "sqlite",
          state: "expecting-transfer",
          transferFrom: params.fromScript,
        },
      },
      tags: [
        `alchemy:stack:${params.scratch.name}`,
        `alchemy:stage:${params.scratch.stage}`,
        `alchemy:id:${params.logicalId}`,
      ],
    },
    files: [
      new File([hostScript([params.className])], "main.js", {
        type: "application/javascript+module",
      }),
    ],
  });
});

/** Commit a staged transfer on the former host, as the second step does. */
const commitTransfer = Effect.fn(function* (params: {
  fromScript: string;
  toScript: string;
  className: string;
}) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  yield* workers.patchScriptScriptAndVersionSetting({
    accountId,
    scriptName: params.fromScript,
    settings: {
      exports: {
        [params.className]: {
          type: "durable-object",
          state: "transferred",
          transferred_to: params.toScript,
        },
      },
    },
  });
});

describe.concurrent(
  "Durable Object migrations → exports upgrade",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test.provider(
      "upgrades a worker deployed with migrations, keeping its data",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "plain");
          yield* deleteScript(scriptName);

          const legacyUrl = yield* deployWithMigrations({
            scratch,
            logicalId: "Upgraded",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${legacyUrl}/increment`)).value).toBe(
            1,
          );
          const before = yield* namespacesOf(scriptName);

          const program = Cloudflare.Worker("Upgraded", {
            name: scriptName,
            script: hostScript(["Counter"]),
            env: { Counter: Cloudflare.DurableObject("Counter") },
          });

          const upgraded = yield* scratch.deploy(program);
          expect(upgraded.durableObjectNamespaces.Counter).toBe(before.Counter);
          expect(yield* namespacesOf(scriptName)).toEqual(before);
          expect((yield* fetchJsonReady<{ value: number }>(`${upgraded.url}/get`)).value).toBe(1);
          expect(
            (yield* fetchJsonReady<{ value: number }>(`${upgraded.url}/increment`)).value,
          ).toBe(2);

          // A routine redeploy on the exports flow is steady.
          const redeployed = yield* scratch.deploy(program);
          expect((yield* fetchJsonReady<{ value: number }>(`${redeployed.url}/get`)).value).toBe(2);
          expect(yield* namespacesOf(scriptName)).toEqual(before);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "upgrades a worker whose class was renamed under migrations",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "renamed");
          yield* deleteScript(scriptName);

          const legacyUrl = yield* deployWithMigrations({
            scratch,
            logicalId: "Renamed",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newTag: "v1", newSqliteClasses: ["Counter"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${legacyUrl}/increment`)).value).toBe(
            1,
          );
          const original = yield* namespacesOf(scriptName);

          // The earlier release's rename: same logical id, new class name.
          yield* deployWithMigrations({
            scratch,
            logicalId: "Renamed",
            scriptName,
            script: hostScript(["CounterV2"]),
            bindings: [{ logicalId: "Counter", className: "CounterV2" }],
            migrations: {
              oldTag: "v1",
              newTag: "v2",
              renamedClasses: [{ from: "Counter", to: "CounterV2" }],
            },
          });

          const upgraded = yield* scratch.deploy(
            Cloudflare.Worker("Renamed", {
              name: scriptName,
              script: hostScript(["CounterV2"]),
              env: { Counter: Cloudflare.DurableObject("Counter", { className: "CounterV2" }) },
            }),
          );
          expect(upgraded.durableObjectNamespaces.CounterV2).toBe(original.Counter);
          expect(yield* namespacesOf(scriptName)).toEqual({ CounterV2: original.Counter });
          expect((yield* fetchJsonReady<{ value: number }>(`${upgraded.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "renames and deletes after upgrading apply through exports",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "lifecycle");
          yield* deleteScript(scriptName);

          const legacyUrl = yield* deployWithMigrations({
            scratch,
            logicalId: "Lifecycle",
            scriptName,
            script: hostScript(["Counter", "Extra"]),
            bindings: [
              { logicalId: "Counter", className: "Counter" },
              { logicalId: "Extra", className: "Extra" },
            ],
            migrations: { newSqliteClasses: ["Counter", "Extra"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${legacyUrl}/increment`)).value).toBe(
            1,
          );
          const before = yield* namespacesOf(scriptName);

          yield* scratch.deploy(
            Cloudflare.Worker("Lifecycle", {
              name: scriptName,
              script: hostScript(["Counter", "Extra"]),
              env: {
                Counter: Cloudflare.DurableObject("Counter"),
                Extra: Cloudflare.DurableObject("Extra"),
              },
            }),
          );

          // Rename Counter → CounterV2 on the exports flow.
          const renamed = yield* scratch.deploy(
            Cloudflare.Worker("Lifecycle", {
              name: scriptName,
              script: hostScript(["CounterV2", "Extra"]),
              env: {
                Counter: Cloudflare.DurableObject("Counter", { className: "CounterV2" }),
                Extra: Cloudflare.DurableObject("Extra"),
              },
            }),
          );
          expect(renamed.durableObjectNamespaces.CounterV2).toBe(before.Counter);
          expect((yield* fetchJsonReady<{ value: number }>(`${renamed.url}/get`)).value).toBe(1);

          // Delete Extra on the exports flow.
          const deleted = yield* scratch.deploy(
            Cloudflare.Worker("Lifecycle", {
              name: scriptName,
              script: hostScript(["CounterV2"]),
              env: { Counter: Cloudflare.DurableObject("Counter", { className: "CounterV2" }) },
            }),
          );
          expect(yield* namespacesOf(scriptName)).toEqual({ CounterV2: before.Counter });
          expect((yield* fetchJsonReady<{ value: number }>(`${deleted.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "the first deploy after upgrading refuses a gradual rollout until it runs at 100%",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "gradual");
          yield* deleteScript(scriptName);

          const program = (marker: string, traffic?: number) =>
            Cloudflare.Worker("Gradual", {
              name: scriptName,
              script: `${hostScript(["Counter"])}\n// ${marker}\n`,
              env: { Counter: Cloudflare.DurableObject("Counter") },
              ...(traffic !== undefined ? { version: { traffic } } : {}),
            });

          // Give the stack a recorded deployment, then put the script back on
          // the earlier release's migrations flow: the state a user has right
          // before upgrading.
          yield* scratch.deploy(program("v0"));
          yield* deleteScript(scriptName);
          yield* deployWithMigrations({
            scratch,
            logicalId: "Gradual",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });

          const refused = yield* scratch.deploy(program("v1", 50)).pipe(Effect.flip);
          expect(String(refused)).toContain("still uses migrations");

          // At 100% the upgrade lands; gradual rollouts work again afterwards.
          yield* scratch.deploy(program("v1"));
          const gradual = yield* scratch.deploy(program("v2", 50));
          expect(gradual.workerName).toBe(scriptName);
          const { accountId } = yield* yield* CloudflareEnvironment;
          const { deployments } = yield* workers.listScriptDeployments({ accountId, scriptName });
          expect(deployments[0]?.versions.map((v) => v.percentage).sort()).toEqual([50, 50]);

          yield* scratch.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "a version worker of an upgraded parent deploys",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "version");
          yield* deleteScript(scriptName);

          yield* deployWithMigrations({
            scratch,
            logicalId: "VersionParent",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });

          const { parent, canary } = yield* scratch.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("VersionParent", {
                name: scriptName,
                script: hostScript(["Counter"]),
                env: { Counter: Cloudflare.DurableObject("Counter") },
              });
              // A version runs the parent's script, so it exports the
              // parent's Durable Object class without binding it.
              const canary = yield* Cloudflare.Worker("VersionCanary", {
                script: `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {}
export default { fetch() { return new Response("canary"); } };
`,
                version: { parent, traffic: 25 },
              });
              return { parent, canary };
            }),
          );
          expect(canary.versionOf).toBe(parent.workerName);

          const { accountId } = yield* yield* CloudflareEnvironment;
          const { deployments } = yield* workers.listScriptDeployments({ accountId, scriptName });
          expect(deployments[0]?.versions.map((v) => v.percentage).sort()).toEqual([25, 75]);

          yield* scratch.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "a preview of an upgraded worker deploys",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "preview");
          yield* deleteScript(scriptName);

          yield* deployWithMigrations({
            scratch,
            logicalId: "PreviewParent",
            scriptName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });

          const { preview } = yield* scratch.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("PreviewParent", {
                name: scriptName,
                script: hostScript(["Counter"]),
                env: { Counter: Cloudflare.DurableObject("Counter") },
              });
              const preview = yield* Cloudflare.Worker("PreviewChild", {
                script: hostScript(["Counter"]),
                env: { Counter: Cloudflare.DurableObject("Counter") },
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );
          expect(preview.previewId).toBeDefined();
          expect((yield* fetchJsonReady<{ value: number }>(`${preview.url}/increment`)).value).toBe(
            1,
          );

          yield* scratch.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "keeps a provisioned class the earlier release never bound",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "unbound");
          yield* deleteScript(scriptName);

          // `Unbound` is exported and provisioned but has no binding: the
          // earlier release only tracked `Counter`.
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* workers.putScript({
            accountId,
            scriptName,
            metadata: {
              mainModule: "main.js",
              compatibilityDate: "2026-08-31",
              bindings: [
                { type: "durable_object_namespace", name: "Counter", className: "Counter" },
              ],
              migrations: { newSqliteClasses: ["Counter", "Unbound"] },
              tags: [
                `alchemy:stack:${scratch.name}`,
                `alchemy:stage:${scratch.stage}`,
                "alchemy:id:Unbound",
                ...encodeDurableObjectTags([{ logicalId: "Counter", className: "Counter" }]),
              ],
            },
            files: [
              new File([hostScript(["Counter", "Unbound"])], "main.js", {
                type: "application/javascript+module",
              }),
            ],
          });
          const before = yield* namespacesOf(scriptName);
          expect(Object.keys(before).sort()).toEqual(["Counter", "Unbound"]);

          yield* scratch.deploy(
            Cloudflare.Worker("Unbound", {
              name: scriptName,
              script: hostScript(["Counter", "Unbound"]),
              env: { Counter: Cloudflare.DurableObject("Counter") },
            }),
          );
          expect(yield* namespacesOf(scriptName)).toEqual(before);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "transfers a class from a former host still on migrations",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const sourceName = scriptNameFor(scratch, "xfer-src");
          const targetName = scriptNameFor(scratch, "xfer-dst");
          yield* deleteScript(sourceName);
          yield* deleteScript(targetName);

          // A former host in another stack, still deployed by the earlier
          // release, hosting the moving class and one that stays.
          const sourceUrl = yield* deployWithMigrations({
            scratch,
            stackName: "other-stack",
            logicalId: "Source",
            scriptName: sourceName,
            script: hostScript(["Counter", "Stays"]),
            bindings: [
              { logicalId: "Counter", className: "Counter" },
              { logicalId: "Stays", className: "Stays" },
            ],
            migrations: { newSqliteClasses: ["Counter", "Stays"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${sourceUrl}/increment`)).value).toBe(
            1,
          );
          const before = yield* namespacesOf(sourceName);

          const target = yield* scratch.deploy(
            Cloudflare.Worker("Target", {
              name: targetName,
              script: hostScript(["Counter"]),
              env: {
                Counter: Cloudflare.DurableObject("Counter", { transferredFrom: sourceName }),
              },
            }),
          );
          // The namespace moved with its data; the other class stayed put.
          expect(target.durableObjectNamespaces.Counter).toBe(before.Counter);
          expect(yield* namespacesOf(targetName)).toEqual({ Counter: before.Counter });
          expect(yield* namespacesOf(sourceName)).toEqual({ Stays: before.Stays });
          expect((yield* fetchJsonReady<{ value: number }>(`${target.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          yield* deleteScript(sourceName);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "finishes a transfer that crashed before the former host committed it",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const sourceName = scriptNameFor(scratch, "crash1-src");
          const targetName = scriptNameFor(scratch, "crash1-dst");
          yield* deleteScript(sourceName);
          yield* deleteScript(targetName);

          const sourceUrl = yield* deployWithMigrations({
            scratch,
            stackName: "other-stack",
            logicalId: "Source",
            scriptName: sourceName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${sourceUrl}/increment`)).value).toBe(
            1,
          );
          const before = yield* namespacesOf(sourceName);

          yield* stageTransfer({
            scratch,
            logicalId: "Target",
            scriptName: targetName,
            fromScript: sourceName,
            className: "Counter",
          });

          const target = yield* scratch.deploy(
            Cloudflare.Worker("Target", {
              name: targetName,
              script: hostScript(["Counter"]),
              env: {
                Counter: Cloudflare.DurableObject("Counter", { transferredFrom: sourceName }),
              },
            }),
          );
          expect(target.durableObjectNamespaces.Counter).toBe(before.Counter);
          expect((yield* fetchJsonReady<{ value: number }>(`${target.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          yield* deleteScript(sourceName);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "finishes a transfer that crashed after the former host committed it",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const sourceName = scriptNameFor(scratch, "crash2-src");
          const targetName = scriptNameFor(scratch, "crash2-dst");
          yield* deleteScript(sourceName);
          yield* deleteScript(targetName);

          const sourceUrl = yield* deployWithMigrations({
            scratch,
            stackName: "other-stack",
            logicalId: "Source",
            scriptName: sourceName,
            script: hostScript(["Counter"]),
            bindings: [{ logicalId: "Counter", className: "Counter" }],
            migrations: { newSqliteClasses: ["Counter"] },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${sourceUrl}/increment`)).value).toBe(
            1,
          );
          const before = yield* namespacesOf(sourceName);

          yield* stageTransfer({
            scratch,
            logicalId: "Target",
            scriptName: targetName,
            fromScript: sourceName,
            className: "Counter",
          });
          yield* commitTransfer({
            fromScript: sourceName,
            toScript: targetName,
            className: "Counter",
          });
          expect(yield* namespacesOf(targetName)).toEqual({ Counter: before.Counter });

          const target = yield* scratch.deploy(
            Cloudflare.Worker("Target", {
              name: targetName,
              script: hostScript(["Counter"]),
              env: {
                Counter: Cloudflare.DurableObject("Counter", { transferredFrom: sourceName }),
              },
            }),
          );
          expect(target.durableObjectNamespaces.Counter).toBe(before.Counter);
          expect((yield* fetchJsonReady<{ value: number }>(`${target.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          yield* deleteScript(sourceName);
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "removing a binding whose class is still in the code keeps the namespace",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "keep");
          yield* deleteScript(scriptName);

          const program = (bindExtra: boolean) =>
            Cloudflare.Worker("Keep", {
              name: scriptName,
              script: hostScript(["Counter", "Extra"]),
              env: bindExtra
                ? {
                    Counter: Cloudflare.DurableObject("Counter"),
                    Extra: Cloudflare.DurableObject("Extra"),
                  }
                : { Counter: Cloudflare.DurableObject("Counter") },
            });

          yield* scratch.deploy(program(true));
          const before = yield* namespacesOf(scriptName);

          // `Extra` is still exported, so Cloudflare refuses to delete it.
          const refused = yield* scratch.deploy(program(false)).pipe(Effect.flip);
          expect(String(refused)).toContain("tombstone_delete_class_still_in_code");
          expect(yield* namespacesOf(scriptName)).toEqual(before);

          yield* scratch.destroy();
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "upgrades a dispatch-namespace worker deployed with migrations",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const namespaceName = scriptNameFor(scratch, "wfp-ns");
          const scriptName = scriptNameFor(scratch, "wfp-user");
          const { accountId } = yield* yield* CloudflareEnvironment;

          const program = Effect.gen(function* () {
            const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("Ns", {
              name: namespaceName,
            });
            const user = yield* Cloudflare.Worker("User", {
              name: scriptName,
              namespace: namespace.name,
              script: hostScript(["Counter"]),
              env: { Counter: Cloudflare.DurableObject("Counter") },
            });
            return { namespace, user };
          });

          // The namespace first, then the user script the way the earlier
          // release uploaded it.
          yield* scratch.deploy(
            Cloudflare.WorkersForPlatforms.DispatchNamespace("Ns", { name: namespaceName }),
          );
          yield* wfp.putDispatchNamespaceScript({
            accountId,
            dispatchNamespace: namespaceName,
            scriptName,
            metadata: {
              mainModule: "main.js",
              compatibilityDate: "2026-08-31",
              bindings: [
                { type: "durable_object_namespace", name: "Counter", className: "Counter" },
              ],
              migrations: { newSqliteClasses: ["Counter"] },
              tags: [
                `alchemy:stack:${scratch.name}`,
                `alchemy:stage:${scratch.stage}`,
                "alchemy:id:User",
                ...encodeDurableObjectTags([{ logicalId: "Counter", className: "Counter" }]),
              ],
            },
            files: [
              new File([hostScript(["Counter"])], "main.js", {
                type: "application/javascript+module",
              }),
            ],
          });
          const before = yield* namespacesOf(scriptName, namespaceName);
          expect(Object.keys(before)).toEqual(["Counter"]);

          const upgraded = yield* scratch.deploy(program);
          expect(upgraded.user.workerName).toBe(scriptName);
          expect(yield* namespacesOf(scriptName, namespaceName)).toEqual(before);

          // The upload moved to exports: a later migrations upload is refused.
          const reverted = yield* wfp
            .putDispatchNamespaceScript({
              accountId,
              dispatchNamespace: namespaceName,
              scriptName,
              metadata: {
                mainModule: "main.js",
                compatibilityDate: "2026-08-31",
                migrations: { newTag: "v2" },
              },
              files: [
                new File([hostScript(["Counter"])], "main.js", {
                  type: "application/javascript+module",
                }),
              ],
            })
            .pipe(Effect.flip);
          expect(String(reverted)).toContain("declarative `exports` flow");

          // A routine redeploy is steady.
          yield* scratch.deploy(program);
          expect(yield* namespacesOf(scriptName, namespaceName)).toEqual(before);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName, namespaceName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "an account worker ignores a dispatch worker with the same script name",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const namespaceName = scriptNameFor(scratch, "twin-ns");
          const scriptName = scriptNameFor(scratch, "twin");

          // The same script name in two contexts, hosting different classes.
          const deployed = yield* scratch.deploy(
            Effect.gen(function* () {
              const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("Ns", {
                name: namespaceName,
              });
              yield* Cloudflare.Worker("DispatchTwin", {
                name: scriptName,
                namespace: namespace.name,
                script: hostScript(["Dispatched"], "Dispatched"),
                env: { Dispatched: Cloudflare.DurableObject("Dispatched") },
              });
              return yield* Cloudflare.Worker("AccountTwin", {
                name: scriptName,
                script: hostScript(["Counter"]),
                env: { Counter: Cloudflare.DurableObject("Counter") },
              });
            }),
          );
          expect(Object.keys(yield* namespacesOf(scriptName))).toEqual(["Counter"]);
          expect(Object.keys(yield* namespacesOf(scriptName, namespaceName))).toEqual([
            "Dispatched",
          ]);

          // Redeploying each one keeps them apart.
          yield* scratch.deploy(
            Effect.gen(function* () {
              const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("Ns", {
                name: namespaceName,
              });
              yield* Cloudflare.Worker("DispatchTwin", {
                name: scriptName,
                namespace: namespace.name,
                script: `${hostScript(["Dispatched"], "Dispatched")}\n// v2\n`,
                env: { Dispatched: Cloudflare.DurableObject("Dispatched") },
              });
              return yield* Cloudflare.Worker("AccountTwin", {
                name: scriptName,
                script: `${hostScript(["Counter"])}\n// v2\n`,
                env: { Counter: Cloudflare.DurableObject("Counter") },
              });
            }),
          );
          expect(Object.keys(yield* namespacesOf(scriptName))).toEqual(["Counter"]);
          expect(
            (yield* fetchJsonReady<{ value: number }>(`${deployed.url}/increment`)).value,
          ).toBe(1);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
          expect(yield* namespacesOf(scriptName, namespaceName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "adopts a worker deployed with exports, then renames and deletes through exports",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "adopt-lifecycle");
          yield* deleteScript(scriptName);

          // A Wrangler-style exports deploy: no migrations, no Alchemy tags.
          const url = yield* deployWithExports({
            scriptName,
            script: hostScript(["Counter", "Extra"]),
            bindings: ["Counter", "Extra"],
            exports: {
              Counter: { type: "durable-object", storage: "sqlite" },
              Extra: { type: "durable-object", storage: "sqlite" },
            },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${url}/increment`)).value).toBe(1);
          const before = yield* namespacesOf(scriptName);

          yield* scratch
            .deploy(
              Cloudflare.Worker("AdoptLifecycle", {
                name: scriptName,
                script: hostScript(["Counter", "Extra"]),
                env: {
                  Counter: Cloudflare.DurableObject("Counter"),
                  Extra: Cloudflare.DurableObject("Extra"),
                },
              }),
            )
            .pipe(adopt(true));
          expect(yield* namespacesOf(scriptName)).toEqual(before);

          // Rename Counter → CounterV2 and delete Extra in one deploy.
          const changed = yield* scratch.deploy(
            Cloudflare.Worker("AdoptLifecycle", {
              name: scriptName,
              script: hostScript(["CounterV2"]),
              env: { Counter: Cloudflare.DurableObject("Counter", { className: "CounterV2" }) },
            }),
          );
          expect(yield* namespacesOf(scriptName)).toEqual({ CounterV2: before.Counter });
          expect((yield* fetchJsonReady<{ value: number }>(`${changed.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "adopts a worker whose exports still carry stale tombstones",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const scriptName = scriptNameFor(scratch, "adopt-stale");
          yield* deleteScript(scriptName);

          // Old → New was renamed and Gone was deleted in earlier Wrangler
          // deploys; the config still lists both tombstones.
          yield* deployWithExports({
            scriptName,
            script: hostScript(["Old", "Gone"], "Old"),
            bindings: ["Old", "Gone"],
            exports: {
              Old: { type: "durable-object", storage: "sqlite" },
              Gone: { type: "durable-object", storage: "sqlite" },
            },
          });
          const original = yield* namespacesOf(scriptName);
          const url = yield* deployWithExports({
            scriptName,
            script: hostScript(["New"], "New"),
            bindings: ["New"],
            exports: {
              Old: { type: "durable-object", state: "renamed", renamedTo: "New" },
              New: { type: "durable-object", storage: "sqlite" },
              Gone: { type: "durable-object", state: "deleted" },
            },
          });
          expect((yield* fetchJsonReady<{ value: number }>(`${url}/increment`)).value).toBe(1);
          // The same config again: both tombstones are now stale.
          yield* deployWithExports({
            scriptName,
            script: hostScript(["New"], "New"),
            bindings: ["New"],
            exports: {
              Old: { type: "durable-object", state: "renamed", renamedTo: "New" },
              New: { type: "durable-object", storage: "sqlite" },
              Gone: { type: "durable-object", state: "deleted" },
            },
          });
          expect(yield* namespacesOf(scriptName)).toEqual({ New: original.Old });

          // Alchemy declares only the live class; the stale tombstones drop out.
          const adopted = yield* scratch
            .deploy(
              Cloudflare.Worker("AdoptStale", {
                name: scriptName,
                script: hostScript(["New"], "New"),
                env: { New: Cloudflare.DurableObject("New") },
              }),
            )
            .pipe(adopt(true));
          expect(yield* namespacesOf(scriptName)).toEqual({ New: original.Old });
          expect((yield* fetchJsonReady<{ value: number }>(`${adopted.url}/get`)).value).toBe(1);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 300_000 },
    );

    test.provider(
      "adopts a dispatch-namespace worker deployed with exports",
      (scratch) =>
        Effect.gen(function* () {
          yield* scratch.destroy();
          const namespaceName = scriptNameFor(scratch, "adopt-wfp-ns");
          const scriptName = scriptNameFor(scratch, "adopt-wfp-user");
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* scratch.deploy(
            Cloudflare.WorkersForPlatforms.DispatchNamespace("Ns", { name: namespaceName }),
          );
          yield* wfp.putDispatchNamespaceScript({
            accountId,
            dispatchNamespace: namespaceName,
            scriptName,
            metadata: {
              mainModule: "main.js",
              compatibilityDate: "2026-08-31",
              bindings: [
                { type: "durable_object_namespace", name: "Counter", className: "Counter" },
              ],
              exports: { Counter: { type: "durable-object", storage: "sqlite" } },
            },
            files: [
              new File([hostScript(["Counter"])], "main.js", {
                type: "application/javascript+module",
              }),
            ],
          });
          const before = yield* namespacesOf(scriptName, namespaceName);
          expect(Object.keys(before)).toEqual(["Counter"]);

          const program = Effect.gen(function* () {
            const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("Ns", {
              name: namespaceName,
            });
            return yield* Cloudflare.Worker("User", {
              name: scriptName,
              namespace: namespace.name,
              script: hostScript(["Counter"]),
              env: { Counter: Cloudflare.DurableObject("Counter") },
            });
          });
          yield* scratch.deploy(program).pipe(adopt(true));
          expect(yield* namespacesOf(scriptName, namespaceName)).toEqual(before);

          yield* scratch.deploy(program);
          expect(yield* namespacesOf(scriptName, namespaceName)).toEqual(before);

          yield* scratch.destroy();
          expect(yield* namespacesOf(scriptName, namespaceName)).toEqual({});
        }).pipe(logLevel),
      { timeout: 300_000 },
    );
  },
);

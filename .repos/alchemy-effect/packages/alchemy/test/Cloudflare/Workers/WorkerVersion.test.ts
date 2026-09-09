import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { WorkerVersionConfigError } from "@/Cloudflare/Workers/WorkerProvider.ts";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const script = (marker: string) =>
  `export default { fetch() { return new Response("${marker}"); } };`;

/**
 * The most recent deployment of a script — Cloudflare returns deployments
 * newest-first. Retried briefly: a deployment created moments ago can lag
 * the list endpoint.
 */
const latestDeployment = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const { deployments } = yield* workers.listScriptDeployments({
    accountId,
    scriptName,
  });
  return deployments[0];
});

describe.concurrent("Cloudflare.Worker version", () => {
  test.provider(
    "preview version of a parent worker, promoted to a canary, then released",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Deploy a parent worker and a zero-traffic preview version of it
        // in one stack — `version.parent` takes the parent resource, which
        // also orders the deploy (parent first) and the destroy (version
        // released before the parent script is deleted).
        const v1 = yield* stack.deploy(
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("VersionParent", {
              script: script("parent-marker-v1"),
            });
            const preview = yield* Cloudflare.Worker("VersionPreview", {
              script: script("preview-marker-v1"),
              version: { parent, message: "alchemy preview test" },
            });
            return { parent, preview };
          }),
        );

        // The preview owns no script — it is a version of the parent's.
        expect(v1.preview.versionOf).toEqual(v1.parent.workerName);
        expect(v1.preview.workerName).toEqual(v1.parent.workerName);
        expect(v1.preview.versionId).toBeDefined();
        // Zero traffic: no deployment was created.
        expect(v1.preview.deploymentId).toBeUndefined();
        // Primary URL is the *aliased* preview URL (stable across deploys);
        // the per-version URL (`<version-prefix>-...`) rides in urls.
        expect(v1.preview.versionAlias).toBeDefined();
        expect(v1.preview.url).toEqual(
          expect.stringContaining(
            `https://${v1.preview.versionAlias}-${v1.parent.workerName}.`,
          ),
        );
        expect(v1.preview.urls[1]).toMatch(
          new RegExp(`^https://[0-9a-f]{8}-${v1.parent.workerName}\\.`),
        );

        // The parent's live deployment is untouched (100% on its own
        // version, not the preview's).
        const liveAfterPreview = yield* latestDeployment(v1.parent.workerName);
        expect(liveAfterPreview?.versions).toHaveLength(1);
        expect(liveAfterPreview?.versions[0].percentage).toEqual(100);
        expect(liveAfterPreview?.versions[0].versionId).not.toEqual(
          v1.preview.versionId,
        );

        // Both URLs serve their own code.
        yield* expectUrlContains(v1.parent.url!, "parent-marker-v1", {
          label: "parent serves its own code",
        });
        yield* expectUrlContains(v1.preview.url!, "preview-marker-v1", {
          label: "preview URL serves the version's code",
        });

        // Promote the version to a canary at 25% of the parent's traffic.
        const v2 = yield* stack.deploy(
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("VersionParent", {
              script: script("parent-marker-v1"),
            });
            const canary = yield* Cloudflare.Worker("VersionPreview", {
              script: script("preview-marker-v1"),
              version: { parent, traffic: 25 },
            });
            return { parent, canary };
          }),
        );

        expect(v2.canary.versionId).toBeDefined();
        expect(v2.canary.deploymentId).toBeDefined();
        // The aliased preview URL is stable: the same alias re-points at
        // the newly uploaded version.
        expect(v2.canary.versionAlias).toEqual(v1.preview.versionAlias);
        expect(v2.canary.url).toEqual(v1.preview.url);
        const liveWithCanary = yield* latestDeployment(v2.parent.workerName);
        expect(liveWithCanary?.id).toEqual(v2.canary.deploymentId);
        expect(
          liveWithCanary?.versions.map((v) => v.percentage).sort(),
        ).toEqual([25, 75]);
        expect(
          liveWithCanary?.versions.find(
            (v) => v.versionId === v2.canary.versionId,
          )?.percentage,
        ).toEqual(25);

        // Remove the canary from the stack — delete restores 100% of
        // traffic to the version that held the majority.
        const v3 = yield* stack.deploy(
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("VersionParent", {
              script: script("parent-marker-v1"),
            });
            return { parent };
          }),
        );

        const liveAfterRelease = yield* latestDeployment(v3.parent.workerName);
        expect(liveAfterRelease?.versions).toHaveLength(1);
        expect(liveAfterRelease?.versions[0].percentage).toEqual(100);
        expect(liveAfterRelease?.versions[0].versionId).not.toEqual(
          v2.canary.versionId,
        );
        yield* expectUrlContains(v3.parent.url!, "parent-marker-v1", {
          label: "parent still serves its own code after canary release",
        });

        yield* stack.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* waitForWorkerToBeDeleted(v3.parent.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  test.provider(
    "preview version carries its own static assets",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { parent, preview } = yield* stack.deploy(
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("AssetsVersionParent", {
              script: script("assets-parent-marker"),
            });
            const preview = yield* Cloudflare.Worker("AssetsVersionPreview", {
              script:
                "export default { fetch(request, env) { return env.ASSETS.fetch(request); } };",
              assets: {
                directory: pathe.resolve(import.meta.dirname, "assets"),
                runWorkerFirst: true,
              },
              version: { parent },
            });
            return { parent, preview };
          }),
        );

        expect(preview.versionOf).toEqual(parent.workerName);
        expect(preview.hash?.assets).toBeDefined();
        yield* expectUrlContains(
          new URL("/test.txt", preview.url!).toString(),
          "This is a test file from assets.",
          { label: "preview URL serves the version's static assets" },
        );
        yield* expectUrlContains(parent.url!, "assets-parent-marker", {
          label: "preview assets leave the parent deployment untouched",
        });

        yield* stack.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* waitForWorkerToBeDeleted(parent.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  test.provider(
    "version.parent accepts a literal script name",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { parent } = yield* stack.deploy(
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("StringParent", {
              script: script("string-parent-v1"),
            });
            return { parent };
          }),
        );

        // Reference the parent by its physical script name — the escape
        // hatch for scripts not managed in any reachable stack state.
        const parentName = parent.workerName;
        const { preview } = yield* stack.deploy(
          Effect.gen(function* () {
            yield* Cloudflare.Worker("StringParent", {
              script: script("string-parent-v1"),
            });
            const preview = yield* Cloudflare.Worker("StringPreview", {
              script: script("string-preview-v1"),
              version: { parent: parentName },
            });
            return { preview };
          }),
        );

        expect(preview.versionOf).toEqual(parentName);
        yield* expectUrlContains(preview.url!, "string-preview-v1", {
          label: "string-parent preview URL serves the version's code",
        });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  test.provider(
    "gradual rollout splits traffic between a worker's own versions",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // First deploy: version.traffic is set, but there is no previous
        // live version to split against — deploys at 100%.
        const v1 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RolloutWorker", {
              script: script("rollout-v1"),
              version: { traffic: 50 },
            });
          }),
        );
        const liveV1 = yield* latestDeployment(v1.workerName);
        expect(liveV1?.versions).toHaveLength(1);
        expect(liveV1?.versions[0].percentage).toEqual(100);
        yield* expectUrlContains(v1.url!, "rollout-v1", {
          label: "first deploy serves at 100%",
        });

        // Second deploy with new code at 50%: the new version and the
        // previously-live version split the traffic.
        const v2 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RolloutWorker", {
              script: script("rollout-v2"),
              version: { traffic: 50, message: "canary rollout" },
            });
          }),
        );
        expect(v2.versionId).toBeDefined();
        expect(v2.deploymentId).toBeDefined();
        const liveV2 = yield* latestDeployment(v2.workerName);
        expect(liveV2?.id).toEqual(v2.deploymentId);
        expect(liveV2?.versions.map((v) => v.percentage).sort()).toEqual([
          50, 50,
        ]);
        expect(liveV2?.versions.some((v) => v.versionId === v2.versionId)).toBe(
          true,
        );
        // urls ordering during a rollout: the stable workers.dev URL stays
        // primary; the uploaded version's preview URL trails.
        expect(v2.urls[0]).toMatch(
          new RegExp(`^https://${v2.workerName}\\..*\\.workers\\.dev$`),
        );
        expect(v2.urls[v2.urls.length - 1]).toMatch(
          new RegExp(
            `^https://${v2.versionId!.split("-")[0]}-${v2.workerName}\\..*\\.workers\\.dev$`,
          ),
        );

        // Promote: traffic back to the default full cutover.
        const v3 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RolloutWorker", {
              script: script("rollout-v3"),
            });
          }),
        );
        const liveV3 = yield* latestDeployment(v3.workerName);
        expect(liveV3?.versions).toHaveLength(1);
        expect(liveV3?.versions[0].percentage).toEqual(100);
        yield* expectUrlContains(v3.url!, "rollout-v3", {
          label: "full deploy serves the new version everywhere",
        });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  test.provider(
    "Worker.URL on a version worker resolves to the aliased preview URL",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { preview } = yield* stack.deploy(
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("SelfUrlParent", {
              script: script("self-url-parent-v1"),
            });
            // Async version worker binding its own URL via env — the
            // self_url sentinel must lower into the aliased preview URL,
            // which is known before the version exists.
            const preview = yield* Cloudflare.Worker("SelfUrlPreview", {
              script: `export default { fetch(request, env) { return new Response(env.PUBLIC_URL); } };`,
              env: { PUBLIC_URL: Cloudflare.Worker.URL },
              version: { parent },
            });
            return { preview };
          }),
        );

        expect(preview.versionAlias).toBeDefined();
        expect(preview.url).toEqual(
          expect.stringContaining(`https://${preview.versionAlias}-`),
        );
        // The deployed version reports its own aliased preview URL.
        yield* expectUrlContains(preview.url!, preview.url!, {
          label: "version's PUBLIC_URL equals its aliased preview URL",
        });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  // State-migration: version workers deployed by the pre-url-redesign
  // provider (#948) persisted their preview URLs in a `domains` list with
  // no `urls`/`domain` attributes, and a metadata hash computed over the
  // old url/subdomain surface. A props-identical redeploy must migrate the
  // record as a one-time update and settle back to noop.
  test.provider(
    "props-identical redeploy migrates pre-redesign version-worker state",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = Effect.gen(function* () {
          const parent = yield* Cloudflare.Worker("MigrParent", {
            script: script("migr-parent-v1"),
          });
          const preview = yield* Cloudflare.Worker("MigrPreview", {
            script: script("migr-preview-v1"),
            version: { parent },
          });
          return { parent, preview };
        });

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        const v1 = yield* stack.deploy(program);
        expect(v1.preview.urls).toHaveLength(2);

        // Rewrite the version worker's record to the #948-era shape:
        // preview URLs in `domains`, no `urls`/`domain`, legacy hash.
        yield* Effect.gen(function* () {
          const state = yield* yield* State;
          const key = { stack: stack.name, stage: "test", fqn: "MigrPreview" };
          const current = yield* state.get(key);
          expect(current).toBeDefined();
          const attr = {
            ...(current as any).attr,
            domains: [...(current as any).attr.urls],
            hash: { ...(current as any).attr.hash, metadata: "legacy" },
          };
          delete attr.urls;
          delete attr.domain;
          yield* state.set({ ...key, value: { ...(current as any), attr } });
        }).pipe(Effect.provide(stack.state));

        // Identical props still plan as an update, driven by the metadata
        // hash surface change alone.
        const migrationPlan = yield* stack.plan(program);
        expect(actionOf(migrationPlan, "MigrPreview")).toBe("update");

        const v2 = yield* stack.deploy(program);
        // The aliased preview URL is deterministic, so it survives the
        // migration byte-for-byte; the per-version URL is re-minted by the
        // migration's version upload.
        expect(v2.preview.urls[0]).toEqual(v1.preview.urls[0]);
        expect(v2.preview.urls[1]).toMatch(
          new RegExp(`^https://[0-9a-f]{8}-${v2.parent.workerName}\\.`),
        );
        expect(v2.preview.domain).toBeUndefined();

        // One-time: the same program now settles as a full noop.
        const settledPlan = yield* stack.plan(program);
        expect(actionOf(settledPlan, "MigrParent")).toBe("noop");
        expect(actionOf(settledPlan, "MigrPreview")).toBe("noop");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  test.provider(
    "rejects script-level settings on a version worker",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { parent } = yield* stack.deploy(
          Effect.gen(function* () {
            const parent = yield* Cloudflare.Worker("InvalidParent", {
              script: script("invalid-parent-v1"),
            });
            return { parent };
          }),
        );

        const error = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* Cloudflare.Worker("InvalidParent", {
                script: script("invalid-parent-v1"),
              });
              return yield* Cloudflare.Worker("InvalidPreview", {
                script: script("invalid-preview-v1"),
                version: { parent: parent.workerName },
                crons: ["*/5 * * * *"],
              });
            }),
          )
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkerVersionConfigError);
        expect(String(error)).toContain("script-level settings");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );
});

import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as pages from "@distilled.cloud/cloudflare/pages";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic project name (never derived from Date.now() or randomness).
// Project names form globally-unique *.pages.dev subdomains, so it carries
// an alchemy-e3 prefix to avoid collisions.
const PROJECT_NAME = "alchemy-e3-pages-deployment";

// Separate project for the `list` suite so the two tests never contend for
// the same deterministically-named project.
const LIST_PROJECT_NAME = "alchemy-e3-pages-deploy-list";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on the test's own out-of-band
// verification calls.
const getDeployment = (
  accountId: string,
  projectName: string,
  deploymentId: string,
) =>
  pages.getProjectDeployment({ accountId, projectName, deploymentId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectDeploymentGone = (
  accountId: string,
  projectName: string,
  deploymentId: string,
) =>
  getDeployment(accountId, projectName, deploymentId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "DeploymentNotDeleted" } as const),
    ),
    // A missing deployment surfaces as `DeploymentNotFound` (Cloudflare
    // error code 8000009) — that's the success condition here. A missing
    // project (cascade delete) also counts.
    Effect.catchTag("DeploymentNotFound", () => Effect.void),
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "DeploymentNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const expectProjectGone = (accountId: string, projectName: string) =>
  pages.getProject({ accountId, projectName }).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "ProjectNotDeleted" } as const)),
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ProjectNotDeleted" || e._tag === "Forbidden",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Purge leftovers from interrupted runs so the deterministically-named
// project starts from a clean slate (deleting the project deletes all of
// its deployments).
const purgeProject = (accountId: string, projectName: string) =>
  pages.deleteProject({ accountId, projectName }).pipe(
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider(
  "create, replace on branch change, and destroy a deployment",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* purgeProject(accountId, PROJECT_NAME);

      const makeStack = (branch?: string) =>
        Effect.gen(function* () {
          const project = yield* Cloudflare.Pages.Project("DeployProject", {
            name: PROJECT_NAME,
          }).pipe(adopt(true));
          const deployment = yield* Cloudflare.Pages.Deployment("Deployment", {
            projectName: project.name,
            ...(branch === undefined ? {} : { branch }),
          });
          return { deployment };
        });

      // 1. Create — no branch means the project's production branch, so
      //    this is the project's first production deployment.
      const initial = (yield* stack.deploy(makeStack())).deployment;

      expect(initial.deploymentId).toBeDefined();
      expect(initial.accountId).toEqual(accountId);
      expect(initial.projectName).toEqual(PROJECT_NAME);
      expect(initial.environment).toEqual("production");
      expect(initial.branch).toEqual("main");
      expect(initial.url).toContain(`${PROJECT_NAME}.pages.dev`);
      expect(initial.latestStageName).toEqual("deploy");
      expect(initial.latestStageStatus).toEqual("success");

      const live = yield* getDeployment(
        accountId,
        PROJECT_NAME,
        initial.deploymentId,
      );
      expect(live.id).toEqual(initial.deploymentId);
      expect(live.environment).toEqual("production");

      // 2. Redeploying identical props is a no-op — same deployment.
      const noop = (yield* stack.deploy(makeStack())).deployment;
      expect(noop.deploymentId).toEqual(initial.deploymentId);

      // 3. Deployments are immutable — changing the branch replaces the
      //    deployment with a new (preview) one.
      const preview1 = (yield* stack.deploy(makeStack("preview-1"))).deployment;
      expect(preview1.deploymentId).not.toEqual(initial.deploymentId);
      expect(preview1.environment).toEqual("preview");
      expect(preview1.branch).toEqual("preview-1");

      // The replaced deployment was the project's active production
      // deployment, which Cloudflare refuses to delete — the provider
      // tolerates that, so it must still exist.
      const stillLive = yield* getDeployment(
        accountId,
        PROJECT_NAME,
        initial.deploymentId,
      );
      expect(stillLive.id).toEqual(initial.deploymentId);

      // 4. Replacing a preview deployment force-deletes the old one.
      const preview2 = (yield* stack.deploy(makeStack("preview-2"))).deployment;
      expect(preview2.deploymentId).not.toEqual(preview1.deploymentId);
      expect(preview2.branch).toEqual("preview-2");

      yield* expectDeploymentGone(
        accountId,
        PROJECT_NAME,
        preview1.deploymentId,
      );

      // 5. Destroy — the preview deployment is force-deleted, then the
      //    project (and with it the remaining production deployment) goes.
      yield* stack.destroy();

      yield* expectProjectGone(accountId, PROJECT_NAME);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// `list()` fans out over `pages.listProjects` → per-project
// `pages.listProjectDeployments`. The live list assertion is gated behind
// CLOUDFLARE_TEST_PAGES_LIST because `pages.listProjects` currently fails to
// decode: direct-upload / ad_hoc deployments return no `source` field, but
// the generated `ListProjectsResponse` schema marks
// `canonicalDeployment.source` and `latestDeployment.source` as required
// (`Schema.Struct`, not `Schema.optional`). The failure surfaces as:
//   CloudflareHttpError { status: 200, statusText: "Schema decode failed" }
// NEEDED DISTILLED PATCH: make the deployment-level `source` optional on the
// projects-list response (and on every other deployment object that can be an
// ad_hoc/direct-upload deployment). Patch + regen `pages`, then remove the
// gate — `list()` itself is already correct.
test.provider.skipIf(!process.env.CLOUDFLARE_TEST_PAGES_LIST)(
  "list enumerates deployments across Pages projects",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* purgeProject(accountId, LIST_PROJECT_NAME);

      yield* Effect.gen(function* () {
        const deployed = (yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Cloudflare.Pages.Project(
              "ListDeployProject",
              { name: LIST_PROJECT_NAME },
            ).pipe(adopt(true));
            const deployment = yield* Cloudflare.Pages.Deployment(
              "ListDeployment",
              { projectName: project.name },
            );
            return { deployment };
          }),
        )).deployment;

        const provider = yield* Provider.findProvider(
          Cloudflare.Pages.Deployment,
        );
        // The deployment fans out across all account projects; ride out edge
        // propagation of the freshly-created project before asserting presence.
        const all = yield* provider.list().pipe(
          Effect.flatMap((rows) =>
            rows.some((d) => d.deploymentId === deployed.deploymentId)
              ? Effect.succeed(rows)
              : Effect.fail({ _tag: "DeploymentNotListedYet" } as const),
          ),
          Effect.retry({
            while: (e) => e._tag === "DeploymentNotListedYet",
            schedule: Schedule.max([
              Schedule.exponential("500 millis"),
              Schedule.recurs(8),
            ]),
          }),
        );

        const found = all.find((d) => d.deploymentId === deployed.deploymentId);
        expect(found).toBeDefined();
        expect(found?.accountId).toEqual(accountId);
        expect(found?.projectName).toEqual(LIST_PROJECT_NAME);
        expect(found?.url).toEqual(deployed.url);
        expect(found?.shortId).toEqual(deployed.shortId);
      }).pipe(
        Effect.ensuring(
          stack
            .destroy()
            .pipe(
              Effect.andThen(purgeProject(accountId, LIST_PROJECT_NAME)),
              Effect.ignore,
            ),
        ),
      );

      yield* expectProjectGone(accountId, LIST_PROJECT_NAME);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

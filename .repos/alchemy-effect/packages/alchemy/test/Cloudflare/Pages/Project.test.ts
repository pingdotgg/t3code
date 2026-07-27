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

// Deterministic per-test project names (never derived from Date.now() or
// randomness). Project names form globally-unique *.pages.dev subdomains,
// so they carry an alchemy-e3 prefix to avoid collisions.
const NAME_UPDATE = "alchemy-e3-pages-update";
const NAME_REPLACE_A = "alchemy-e3-pages-replace-a";
const NAME_REPLACE_B = "alchemy-e3-pages-replace-b";
const NAME_LIST = "alchemy-e3-pages-list";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on the test's own out-of-band
// verification calls.
const getProject = (accountId: string, projectName: string) =>
  pages.getProject({ accountId, projectName }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, projectName: string) =>
  getProject(accountId, projectName).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "ProjectNotDeleted" } as const)),
    // A missing project surfaces as `ProjectNotFound` (Cloudflare error
    // code 8000007) — that's the success condition here.
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ProjectNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Purge leftovers from interrupted runs so deterministically-named tests
// start from a clean slate.
const purgeProject = (accountId: string, projectName: string) =>
  pages.deleteProject({ accountId, projectName }).pipe(
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider("create and delete a project with generated name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const project = yield* stack.deploy(
      Cloudflare.Pages.Project("DefaultProject", {}),
    );

    expect(project.projectId).toBeDefined();
    expect(project.accountId).toEqual(accountId);
    expect(project.name).toBeTruthy();
    expect(project.subdomain).toEqual(`${project.name}.pages.dev`);
    expect(project.productionBranch).toEqual("main");
    expect(project.createdOn).toBeTruthy();

    const live = yield* getProject(accountId, project.name);
    expect(live.id).toEqual(project.projectId);
    expect(live.name).toEqual(project.name);
    expect(live.productionBranch).toEqual("main");

    yield* stack.destroy();

    yield* expectGone(accountId, project.name);
  }).pipe(logLevel),
);

test.provider("update mutable props in place (same project id)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* purgeProject(accountId, NAME_UPDATE);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Pages.Project("UpdateProject", {
          name: NAME_UPDATE,
          productionBranch: "main",
          buildConfig: {
            buildCommand: "npm run build",
            destinationDir: "dist",
          },
          deploymentConfigs: {
            production: {
              compatibilityDate: "2025-01-01",
              envVars: {
                FOO: { value: "foo-v1" },
                DROP_ME: { value: "going-away" },
              },
            },
          },
        }).pipe(adopt(true));
      }),
    );

    expect(initial.name).toEqual(NAME_UPDATE);
    expect(initial.productionBranch).toEqual("main");

    const observed = yield* getProject(accountId, NAME_UPDATE);
    expect(observed.buildConfig?.buildCommand).toEqual("npm run build");
    expect(observed.deploymentConfigs.production?.envVars).toMatchObject({
      FOO: { value: "foo-v1" },
      DROP_ME: { value: "going-away" },
    });

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Pages.Project("UpdateProject", {
          name: NAME_UPDATE,
          productionBranch: "develop",
          buildConfig: {
            buildCommand: "npm run build:v2",
            destinationDir: "out",
          },
          deploymentConfigs: {
            production: {
              compatibilityDate: "2025-06-01",
              envVars: {
                FOO: { value: "foo-v2" },
                BAR: { value: "bar-v1" },
              },
            },
          },
        }).pipe(adopt(true));
      }),
    );

    // Same project mutated in place — not a replacement.
    expect(updated.projectId).toEqual(initial.projectId);
    expect(updated.productionBranch).toEqual("develop");

    const live = yield* getProject(accountId, NAME_UPDATE);
    expect(live.productionBranch).toEqual("develop");
    expect(live.buildConfig?.buildCommand).toEqual("npm run build:v2");
    expect(live.buildConfig?.destinationDir).toEqual("out");
    expect(live.deploymentConfigs.production?.compatibilityDate).toEqual(
      "2025-06-01",
    );
    expect(live.deploymentConfigs.production?.envVars).toMatchObject({
      FOO: { value: "foo-v2" },
      BAR: { value: "bar-v1" },
    });
    // PATCH deep-merges — the reconciler must null out removed env vars.
    expect(live.deploymentConfigs.production?.envVars).not.toHaveProperty(
      "DROP_ME",
    );

    // Redeploying identical props is a no-op (still the same project).
    const noop = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Pages.Project("UpdateProject", {
          name: NAME_UPDATE,
          productionBranch: "develop",
          buildConfig: {
            buildCommand: "npm run build:v2",
            destinationDir: "out",
          },
          deploymentConfigs: {
            production: {
              compatibilityDate: "2025-06-01",
              envVars: {
                FOO: { value: "foo-v2" },
                BAR: { value: "bar-v1" },
              },
            },
          },
        }).pipe(adopt(true));
      }),
    );
    expect(noop.projectId).toEqual(initial.projectId);

    yield* stack.destroy();

    yield* expectGone(accountId, NAME_UPDATE);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed project", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* purgeProject(accountId, NAME_LIST);

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Pages.Project("ListProject", {
          name: NAME_LIST,
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Pages.Project);
    const all = yield* provider.list();

    const match = all.find((p) => p.projectId === deployed.projectId);
    expect(match).toBeDefined();
    expect(match?.name).toEqual(NAME_LIST);
    expect(match?.accountId).toEqual(accountId);
    expect(match?.subdomain).toEqual(`${NAME_LIST}.pages.dev`);

    yield* stack.destroy();

    yield* expectGone(accountId, NAME_LIST);
  }).pipe(logLevel),
);

test.provider("changing the name triggers replacement", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* purgeProject(accountId, NAME_REPLACE_A);
    yield* purgeProject(accountId, NAME_REPLACE_B);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Pages.Project("ReplaceProject", {
          name: NAME_REPLACE_A,
        }).pipe(adopt(true));
      }),
    );

    expect(initial.name).toEqual(NAME_REPLACE_A);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Pages.Project("ReplaceProject", {
          name: NAME_REPLACE_B,
        }).pipe(adopt(true));
      }),
    );

    // The name is the project's identity — a new physical project exists.
    expect(replaced.projectId).not.toEqual(initial.projectId);
    expect(replaced.name).toEqual(NAME_REPLACE_B);

    // The old project was deleted as part of the replacement.
    yield* expectGone(accountId, NAME_REPLACE_A);

    const live = yield* getProject(accountId, NAME_REPLACE_B);
    expect(live.id).toEqual(replaced.projectId);

    yield* stack.destroy();

    yield* expectGone(accountId, NAME_REPLACE_B);
  }).pipe(logLevel),
);

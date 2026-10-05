import {
  Branch,
  type BranchEndpointConfig,
  type BranchProps,
} from "@/Neon/Branch";
import type { PostgresOrigin } from "@/Neon/PostgresOrigin";
import { Project } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import {
  createProjectBranch,
  deleteProjectBranch,
  deleteProjectEndpoint,
  getConnectionURI,
  getProject,
  getProjectBranch,
  listProjectBranchEndpoints,
  updateProjectBranch,
  updateProjectEndpoint,
} from "@distilled.cloud/neon";
import { adopt, OwnedBySomeoneElse, Unowned } from "@/AdoptPolicy";
import * as Result from "effect/Result";
import { waitForOperations } from "@/Neon/Project";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const expectPooledOrigin = (branch: {
  pooledConnectionUri: string;
  pooledOrigin: PostgresOrigin;
}) => {
  const uri = new URL(branch.pooledConnectionUri);
  expect(branch.pooledOrigin).toMatchObject({
    scheme: uri.protocol === "postgresql:" ? "postgresql" : "postgres",
    host: uri.hostname,
    port: uri.port ? Number(uri.port) : 5432,
    database: uri.pathname.replace(/^\//, ""),
    user: decodeURIComponent(uri.username),
  });
  expect(branch.pooledOrigin.password).toBeDefined();
};

// Canonical `list()` test (parent fan-out): branches are scoped to a project
// and there is no account-wide branch enumeration API, so `list()` enumerates
// every project and lists+hydrates the branches of each. Deploy a project +
// branch, then assert the deployed branch appears in the exhaustive result.
describe.concurrent(
  "branch lifecycle",
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
  },
  () => {
    test.provider("list enumerates the deployed branch", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { project, branch } = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("ListBranchProject");
            const branch = yield* Branch("ListBranch", { project });
            return { project, branch };
          }),
        );

        const provider = yield* Provider.findProvider(Branch);
        const all = yield* provider.list();

        const found = all.find((b) => b.branchId === branch.branchId);
        expect(found).toBeDefined();
        expect(found?.projectId).toEqual(project.projectId);
        expect(found?.branchName).toEqual(branch.branchName);
        expect(found?.connectionUri).toContain("postgres");
        expectPooledOrigin(branch);
        expectPooledOrigin(found!);

        yield* stack.destroy();
      }).pipe(logLevel),
    );

    test.provider(
      "updating project in-place does not replace the branch",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Project("UpdateBranchProject", {
                enableLogicalReplication: false,
              });
              const branch = yield* Branch("UpdateBranch", {
                project,
              });
              return { project, branch };
            }),
          );

          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Project("UpdateBranchProject", {
                enableLogicalReplication: true,
              });
              const branch = yield* Branch("UpdateBranch", {
                project,
              });
              return { project, branch };
            }),
          );

          expect(updated.branch.projectId).toEqual(updated.project.projectId);
          expect(updated.branch.branchId).toEqual(initial.branch.branchId);
          expectPooledOrigin(updated.branch);

          yield* stack.destroy();
        }).pipe(logLevel),
    );

    test.provider(
      "replaces branch when project changes to another pre-existing project",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              const projectA = yield* Project("ReplaceBranchProjectA");
              const projectB = yield* Project("ReplaceBranchProjectB");
              const branch = yield* Branch("ReplaceBranchExistingProject", {
                project: projectA,
                name: "cross-project-replacement",
              });
              return { projectA, projectB, branch };
            }),
          );

          const replaced = yield* stack.deploy(
            Effect.gen(function* () {
              const projectA = yield* Project("ReplaceBranchProjectA");
              const projectB = yield* Project("ReplaceBranchProjectB");
              const branch = yield* Branch("ReplaceBranchExistingProject", {
                project: projectB,
                name: "cross-project-replacement",
              });
              return { projectA, projectB, branch };
            }),
          );

          expect(replaced.branch.projectId).toEqual(
            replaced.projectB.projectId,
          );
          expect(replaced.branch.branchId).not.toEqual(initial.branch.branchId);

          const fetched = yield* getProjectBranch({
            project_id: replaced.projectB.projectId,
            branch_id: replaced.branch.branchId,
          });
          expect(fetched.branch.id).toEqual(replaced.branch.branchId);

          const oldBranch = yield* getProjectBranch({
            project_id: initial.projectA.projectId,
            branch_id: initial.branch.branchId,
          }).pipe(
            Effect.as("found" as const),
            Effect.catchTag("NotFound", () =>
              Effect.succeed("not-found" as const),
            ),
          );
          expect(oldBranch).toEqual("not-found");

          yield* stack.destroy();
        }).pipe(logLevel),
    );

    test.provider("replaces branch when project is replaced", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("ReplaceProject", {
              region: "aws-us-east-1",
            });
            const branch = yield* Branch("ReplaceBranchReplaceProject", {
              project,
            });
            return { project, branch };
          }),
        );

        expect(initial.project.region).toEqual("aws-us-east-1");

        // Trigger a replace on the project by changing the region.
        // This should cause the branch to be replaced.
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("ReplaceProject", {
              region: "aws-us-west-2",
            });
            const branch = yield* Branch("ReplaceBranchReplaceProject", {
              project,
            });
            return { project, branch };
          }),
        );

        expect(replaced.project.region).toEqual("aws-us-west-2");
        expect(replaced.branch.projectId).toEqual(replaced.project.projectId);
        expect(replaced.branch.projectId).not.toEqual(
          initial.project.projectId,
        );
        expect(replaced.branch.branchId).not.toEqual(initial.branch.branchId);

        const fetched = yield* getProjectBranch({
          project_id: replaced.project.projectId,
          branch_id: replaced.branch.branchId,
        });
        expect(fetched.branch.id).toEqual(replaced.branch.branchId);

        const oldBranch = yield* getProjectBranch({
          project_id: initial.project.projectId,
          branch_id: initial.branch.branchId,
        }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () =>
            Effect.succeed("not-found" as const),
          ),
        );
        expect(oldBranch).toEqual("not-found");

        yield* stack.destroy();
      }).pipe(logLevel),
    );

    // #736 regression tests: a `creating`-state row persisted before upstream
    // Outputs resolve cannot round-trip Output-valued props — they deserialize as
    // `undefined`. The engine's recovery paths hand those junk props back to the
    // provider as `olds` (Plan.ts calls `read` and then `diff` with
    // `olds: oldState.props` for a creating row with no attributes). The provider
    // must fall through to the create path instead of crashing in
    // `resolveProjectId`.
    //
    // Shared shape (Variant B): deploy a project + branch, rewrite the branch's
    // persisted row into the wedged creating-state shape, delete the branch
    // out-of-band so recovery must recreate it, redeploy, and assert convergence.

    test.provider(
      "converges endpoint settings, removals, drift, and a missing endpoint",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (endpoints?: BranchEndpointConfig[]) =>
            stack.deploy(
              Effect.gen(function* () {
                const project = yield* Project("EndpointProject");
                const branch = yield* Branch("EndpointBranch", {
                  project,
                  endpoints,
                });
                return { project, branch };
              }),
            );
          const initial = yield* deploy([
            {
              type: "read_write",
              autoscalingLimitMinCu: 0.25,
              autoscalingLimitMaxCu: 0.25,
            },
            {
              type: "read_only",
              autoscalingLimitMinCu: 0.25,
              autoscalingLimitMaxCu: 0.25,
            },
          ]);
          const scope = {
            project_id: initial.project.projectId,
            branch_id: initial.branch.branchId,
          };
          const initialEndpoints = (yield* listProjectBranchEndpoints(scope))
            .endpoints;
          expect(initialEndpoints).toHaveLength(2);
          const first = initialEndpoints.find(
            (endpoint) => endpoint.type === "read_write",
          )!;
          const drift = yield* updateProjectEndpoint({
            project_id: scope.project_id,
            endpoint_id: first.id,
            endpoint: { autoscaling_limit_max_cu: 0.5 },
          });
          yield* waitForOperations(drift.operations);
          const updated = yield* deploy([
            {
              type: "read_write",
              autoscalingLimitMinCu: 0.25,
              autoscalingLimitMaxCu: 1,
            },
          ]);
          expect(updated.branch.branchId).toBe(initial.branch.branchId);
          const updatedEndpoints = (yield* listProjectBranchEndpoints(scope))
            .endpoints;
          expect(updatedEndpoints).toHaveLength(1);
          const current = updatedEndpoints[0]!;
          expect(current.id).toBe(first.id);
          expect(current.autoscaling_limit_max_cu).toBe(1);
          const removed = yield* deploy();
          const defaults = (yield* getProject({ project_id: scope.project_id }))
            .project.default_endpoint_settings;
          const reset = (yield* listProjectBranchEndpoints(scope))
            .endpoints[0]!;
          expect(reset.autoscaling_limit_min_cu).toBe(
            defaults?.autoscaling_limit_min_cu ?? 0.25,
          );
          expect(reset.autoscaling_limit_max_cu).toBe(
            defaults?.autoscaling_limit_max_cu ?? 2,
          );
          const deletion = yield* deleteProjectEndpoint({
            project_id: scope.project_id,
            endpoint_id: reset.id,
          });
          yield* waitForOperations(deletion.operations);
          const recovered = yield* deploy([
            {
              type: "read_write",
              autoscalingLimitMinCu: 0.25,
              autoscalingLimitMaxCu: 0.5,
            },
          ]);
          expect(recovered.branch.branchId).toBe(removed.branch.branchId);
          const replacement = (yield* listProjectBranchEndpoints(scope))
            .endpoints[0]!;
          expect(replacement.id).not.toBe(reset.id);
          const uri = yield* getConnectionURI({
            ...scope,
            database_name: recovered.branch.databaseName,
            role_name: recovered.branch.roleName,
            pooled: false,
          });
          expect(recovered.branch.connectionUri === uri.uri).toBe(true);
          yield* stack.destroy();
          yield* stack.destroy();
          expect(
            yield* getProjectBranch(scope).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          ).toBe(true);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "observes a missing branch despite cached output and converges adoption",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const deploy = (protectedBranch?: boolean) =>
            stack.deploy(
              Effect.gen(function* () {
                const project = yield* Project("ObservedProject");
                const branch = yield* Branch("ObservedBranch", {
                  project,
                  protected: protectedBranch,
                });
                return { project, branch };
              }),
            );
          const initial = yield* deploy();
          const provider = yield* Provider.findProvider(Branch);
          const context = {
            id: "ObservedBranch",
            fqn: "ObservedBranch",
            instanceId: "observed-branch",
            bindings: [],
            session: {
              emit: () => Effect.void,
              done: () => Effect.void,
              note: () => Effect.void,
            },
          };
          const news = {
            project: { projectId: initial.project.projectId },
            name: initial.branch.branchName,
          };
          const read = yield* provider.read!({
            ...context,
            olds: news,
            output: undefined,
          });
          expect(Unowned.is(read)).toBe(true);
          const drift = yield* updateProjectBranch({
            project_id: initial.project.projectId,
            branch_id: initial.branch.branchId,
            branch: { name: `${initial.branch.branchName}-drift` },
          });
          yield* waitForOperations(drift.operations);
          const adopted = yield* provider.reconcile({
            ...context,
            news,
            olds: undefined,
            output: initial.branch,
          });
          expect(adopted.branchName).toBe(initial.branch.branchName);
          const unchanged = yield* provider.reconcile({
            ...context,
            news,
            olds: news,
            output: adopted,
          });
          expect(unchanged.branchId).toBe(adopted.branchId);
          yield* deleteBranchOutOfBand(
            initial.project.projectId,
            initial.branch.branchId,
          );
          const recovered = yield* deploy(true);
          expect(recovered.branch.branchId).not.toBe(initial.branch.branchId);
          const persisted = yield* deploy(true);
          expect(persisted.branch.branchId).toBe(recovered.branch.branchId);
          expect(persisted.branch.protected).toBe(true);
          const unprotected = yield* deploy();
          expect(unprotected.branch.protected).toBe(false);
          expect(
            (yield* getProjectBranch({
              project_id: initial.project.projectId,
              branch_id: recovered.branch.branchId,
            })).branch.protected,
          ).toBe(false);
          yield* stack.destroy();
          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "refuses foreign branch ownership until adoption is explicit",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const base = Project("AdoptionProject");
          const project = yield* stack.deploy(base);
          const foreign = yield* createProjectBranch({
            project_id: project.projectId,
            branch: { name: "foreign-branch" },
            endpoints: [{ type: "read_write" }],
          });
          yield* waitForOperations(foreign.operations);
          const program = (allow: boolean) =>
            Effect.gen(function* () {
              const project = yield* base;
              return yield* Branch("AdoptedBranch", {
                project,
                name: "foreign-branch",
              }).pipe(adopt(allow));
            });
          const refused = yield* stack
            .deploy(program(false))
            .pipe(Effect.result);
          expect(Result.isFailure(refused)).toBe(true);
          if (Result.isFailure(refused))
            expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);
          const adopted = yield* stack.deploy(program(true));
          expect(adopted.branchId).toBe(foreign.branch.id);
          expect(
            (yield* getProjectBranch({
              project_id: project.projectId,
              branch_id: adopted.branchId,
            })).branch.name,
          ).toBe("foreign-branch");
          yield* stack.destroy();
          expect(
            yield* getProjectBranch({
              project_id: project.projectId,
              branch_id: adopted.branchId,
            }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          ).toBe(true);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "explicit branch names use delete-first immutable replacements in one project",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const program = (props: Partial<BranchProps> = {}) =>
            Effect.gen(function* () {
              const project = yield* Project("NamedBranchProject");
              const parent = yield* Branch("AlternateParent", { project });
              const branch = yield* Branch("NamedBranch", {
                project,
                name: "named-replacement",
                ...props,
              });
              return { project, parent, branch };
            });
          const initial = yield* stack.deploy(program());
          for (const props of [
            { initSource: "schema-only" },
            { parentBranch: { branchId: initial.parent.branchId } },
            { parentLsn: "0/3FA01B0" },
            { parentTimestamp: "2026-01-01T00:00:00Z" },
          ] satisfies Partial<BranchProps>[]) {
            const plan = yield* stack.plan(program(props));
            expect(plan.resources.NamedBranch).toMatchObject({
              action: "replace",
              deleteFirst: true,
            });
          }
          const renamed = yield* stack.plan(
            program({ name: "renamed-replacement", initSource: "schema-only" }),
          );
          expect(renamed.resources.NamedBranch).toMatchObject({
            action: "replace",
            deleteFirst: false,
          });
          const provider = yield* Provider.findProvider(Branch);
          const recovery = yield* provider
            .reconcile({
              id: "NamedBranch",
              fqn: "NamedBranch",
              instanceId: "replacement-branch",
              news: {
                project: { projectId: initial.project.projectId },
                name: initial.branch.branchName,
                initSource: "schema-only",
              },
              olds: undefined,
              output: undefined,
              bindings: [],
              session: {
                emit: () => Effect.void,
                done: () => Effect.void,
                note: () => Effect.void,
              },
            })
            .pipe(Effect.result);
          expect(Result.isFailure(recovery)).toBe(true);
          if (Result.isFailure(recovery))
            expect(recovery.failure).toBeInstanceOf(OwnedBySomeoneElse);
          const props = {
            initSource: "parent-data" as const,
            parentBranch: { branchId: initial.parent.branchId },
          };
          const reparented = yield* stack.deploy(program(props));
          expect(reparented.branch.branchId).not.toBe(initial.branch.branchId);
          expect(reparented.branch.branchName).toBe(initial.branch.branchName);
          expect(reparented.branch.initSource).toBe("parent-data");
          expect(reparented.branch.parentBranchId).toBe(
            initial.parent.branchId,
          );
          const removal = yield* stack.plan(program());
          expect(removal.resources.NamedBranch).toMatchObject({
            action: "replace",
            deleteFirst: true,
          });
          const current = yield* getProjectBranch({
            project_id: initial.project.projectId,
            branch_id: reparented.branch.branchId,
          });
          expect(current.branch.parent_id).toBe(initial.parent.branchId);
          expect(
            (yield* stack.plan(program(props))).resources.NamedBranch.action,
          ).toBe("noop");
          expect((yield* stack.deploy(program(props))).branch.branchId).toBe(
            reparented.branch.branchId,
          );
          const schemaProps = { initSource: "schema-only" as const };
          const schema = yield* stack.deploy(program(schemaProps));
          expect(schema.branch.branchId).not.toBe(reparented.branch.branchId);
          expect(schema.branch.branchName).toBe(initial.branch.branchName);
          expect(schema.branch.initSource).toBe("schema-only");
          expect(schema.branch.parentBranchId).toBeUndefined();
          expect(
            (yield* getProjectBranch({
              project_id: schema.project.projectId,
              branch_id: schema.branch.branchId,
            })).branch.parent_id,
          ).toBeUndefined();
          for (const branch of [initial.branch, reparented.branch]) {
            expect(
              yield* getProjectBranch({
                project_id: branch.projectId,
                branch_id: branch.branchId,
              }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }
          expect(
            (yield* stack.plan(program(schemaProps))).resources.NamedBranch
              .action,
          ).toBe("noop");
          expect(
            (yield* stack.deploy(program(schemaProps))).branch.branchId,
          ).toBe(schema.branch.branchId);
          yield* stack.destroy();
          expect(
            yield* getProjectBranch({
              project_id: initial.project.projectId,
              branch_id: schema.branch.branchId,
            }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          ).toBe(true);
          expect(
            yield* getProject({ project_id: initial.project.projectId }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          ).toBe(true);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "explicit branch names preserve schema-only roots and replace changed schema sources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const program = (props: Partial<BranchProps> = {}) =>
            Effect.gen(function* () {
              const project = yield* Project("SchemaBranchProject");
              const parent = yield* Branch("SchemaSource", { project });
              const branch = yield* Branch("SchemaBranch", {
                project,
                name: "schema-source-replacement",
                initSource: "schema-only",
                parentBranch: { branchId: project.defaultBranchId },
                ...props,
              });
              return { project, parent, branch };
            });
          const initial = yield* stack.deploy(program());
          expect(initial.branch.initSource).toBe("schema-only");
          expect(initial.branch.parentBranchId).toBeUndefined();
          expect(
            (yield* stack.plan(program())).resources.SchemaBranch.action,
          ).toBe("noop");
          expect((yield* stack.deploy(program())).branch.branchId).toBe(
            initial.branch.branchId,
          );
          const props = {
            parentBranch: { branchId: initial.parent.branchId },
          };
          expect(
            (yield* stack.plan(program(props))).resources.SchemaBranch,
          ).toMatchObject({ action: "replace", deleteFirst: true });
          const replaced = yield* stack.deploy(program(props));
          expect(replaced.branch.branchId).not.toBe(initial.branch.branchId);
          expect(replaced.branch.branchName).toBe(initial.branch.branchName);
          expect(replaced.branch.initSource).toBe("schema-only");
          expect(replaced.branch.parentBranchId).toBeUndefined();
          const current = yield* getProjectBranch({
            project_id: replaced.project.projectId,
            branch_id: replaced.branch.branchId,
          });
          // Neon reports schema-only requests as parent-schema in responses.
          expect(current.branch.init_source).toBe("parent-schema");
          expect(current.branch.parent_id).toBeUndefined();
          for (const next of [{}, { parentBranch: undefined }]) {
            expect(
              (yield* stack.plan(program(next))).resources.SchemaBranch,
            ).toMatchObject({ action: "replace", deleteFirst: true });
          }
          expect(
            (yield* stack.plan(program(props))).resources.SchemaBranch.action,
          ).toBe("noop");
          expect((yield* stack.deploy(program(props))).branch.branchId).toBe(
            replaced.branch.branchId,
          );
          expect(
            yield* getProjectBranch({
              project_id: initial.project.projectId,
              branch_id: initial.branch.branchId,
            }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          ).toBe(true);
          yield* stack.destroy();
          for (const branch of [replaced.branch, initial.parent]) {
            expect(
              yield* getProjectBranch({
                project_id: branch.projectId,
                branch_id: branch.branchId,
              }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }
          expect(
            yield* getProject({ project_id: initial.project.projectId }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          ).toBe(true);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "refuses late same-name branches and foreign replacements of cached identities",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const owners = Effect.gen(function* () {
            const project = yield* Project("LateBranchProject");
            const cached = yield* Branch("CachedBranch", { project });
            const foreign = yield* Branch("ForeignBranch", { project });
            return { project, cached, foreign };
          });
          const initial = yield* stack.deploy(owners);
          const name = "late-branch";
          const plan = yield* stack.plan(
            Effect.gen(function* () {
              const { project } = yield* owners;
              return yield* Branch("LateBranch", { project, name });
            }),
          );
          expect(plan.resources.LateBranch.action).toBe("create");
          const renamed = yield* updateProjectBranch({
            project_id: initial.project.projectId,
            branch_id: initial.foreign.branchId,
            branch: { name },
          });
          yield* waitForOperations(renamed.operations);
          const provider = yield* Provider.findProvider(Branch);
          const context = {
            id: "LateBranch",
            fqn: "LateBranch",
            instanceId: "late-branch",
            bindings: [],
            session: {
              emit: () => Effect.void,
              done: () => Effect.void,
              note: () => Effect.void,
            },
          };
          const news = {
            project: { projectId: initial.project.projectId },
            name,
            protected: true,
          };
          const late = yield* provider
            .reconcile({
              ...context,
              news,
              olds: undefined,
              output: undefined,
            })
            .pipe(Effect.result);
          expect(Result.isFailure(late)).toBe(true);
          if (Result.isFailure(late))
            expect(late.failure).toBeInstanceOf(OwnedBySomeoneElse);
          yield* deleteBranchOutOfBand(
            initial.project.projectId,
            initial.cached.branchId,
          );
          const cached = yield* provider
            .reconcile({
              ...context,
              news,
              olds: news,
              output: initial.cached,
            })
            .pipe(Effect.result);
          expect(Result.isFailure(cached)).toBe(true);
          if (Result.isFailure(cached))
            expect(cached.failure).toBeInstanceOf(OwnedBySomeoneElse);
          const observed = yield* getProjectBranch({
            project_id: initial.project.projectId,
            branch_id: initial.foreign.branchId,
          });
          expect(observed.branch.name).toBe(name);
          expect(observed.branch.protected).toBe(false);
          yield* stack.destroy();
          for (const branch of [initial.cached, initial.foreign]) {
            expect(
              yield* getProjectBranch({
                project_id: initial.project.projectId,
                branch_id: branch.branchId,
              }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }
        }),
      { timeout: 120_000 },
    );
  },
);

/** Rewrite the deployed branch's state row into a wedged `creating` row. */
const wedgeBranchRow = (
  stack: { name: string; stage: string },
  project: unknown,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const stage = stack.stage;
    const fqns = yield* state.list({ stack: stack.name, stage });
    const rows = yield* Effect.forEach(fqns, (fqn) =>
      state
        .get({ stack: stack.name, stage, fqn })
        .pipe(Effect.map((row) => ({ fqn, row }))),
    );
    const wedged = rows.find(
      (r): r is { fqn: string; row: ResourceState } =>
        isResourceState(r.row) && r.row.resourceType === "Neon.Branch",
    );
    if (!wedged) {
      return yield* Effect.die(
        new Error("no Branch state row found after deploy"),
      );
    }
    yield* state.set({
      stack: stack.name,
      stage,
      fqn: wedged.fqn,
      value: {
        ...wedged.row,
        status: "creating",
        attr: undefined,
        props: {
          ...wedged.row.props,
          project,
        },
      },
    });
  });

/** Delete the branch out-of-band and wait (bounded) until it is gone. */
const deleteBranchOutOfBand = (projectId: string, branchId: string) =>
  Effect.gen(function* () {
    yield* deleteProjectBranch({
      project_id: projectId,
      branch_id: branchId,
    }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    const gone = yield* getProjectBranch({
      project_id: projectId,
      branch_id: branchId,
    }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s === "gone",
        times: 10,
      }),
    );
    expect(gone).toEqual("gone");
  });

// `read` guard: the project reference survived the creating-state round-trip
// as an object, but its Output-valued `projectId` did not. Pre-fix, `read`
// crashed with `Error: Invalid Neon project source: must be a Project or
// { projectId }` (thrown by `resolveProjectId`); post-fix it returns
// `undefined` and recovery recreates the branch.
test.provider(
  "recovers a creating-state branch whose project lost its Output-valued projectId (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployBranch = () =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("WedgedReadProject");
            const branch = yield* Branch("WedgedReadBranch", { project });
            return { project, branch };
          }),
        );

      const initial = yield* deployBranch();

      // The #736 shape for the `read` guard: the object survived but the
      // Output-valued `projectId` inside it deserialized as `undefined`.
      yield* wedgeBranchRow(stack, { projectId: undefined });

      // Delete the branch out-of-band so recovery must recreate it (a
      // recovery `read` returning attributes would skip the create path).
      yield* deleteBranchOutOfBand(
        initial.project.projectId,
        initial.branch.branchId,
      );

      const recovered = yield* deployBranch();
      expect(recovered.branch.branchId).toBeDefined();
      expect(recovered.branch.branchId).not.toEqual(initial.branch.branchId);
      expect(recovered.branch.projectId).toEqual(recovered.project.projectId);
      expect(recovered.branch.branchName).toEqual(initial.branch.branchName);

      const fetched = yield* getProjectBranch({
        project_id: recovered.project.projectId,
        branch_id: recovered.branch.branchId,
      });
      expect(fetched.branch.id).toEqual(recovered.branch.branchId);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

// `diff` guard: the whole `project` prop deserialized as `undefined`. `read`
// falls through on `!olds?.project` (both pre- and post-fix), so the engine
// then calls `diff` with the junk olds. Pre-fix, `diff` crashed in
// `resolveProjectId(undefined)`; post-fix the unknown old project id falls
// through to the create/update recovery path (no forced replacement).
test.provider(
  "recovers a creating-state branch whose project prop was lost entirely (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployBranch = () =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("WedgedDiffProject");
            const branch = yield* Branch("WedgedDiffBranch", { project });
            return { project, branch };
          }),
        );

      const initial = yield* deployBranch();

      // The #736 shape for the `diff` guard: the entire Output-valued
      // `project` prop deserialized as `undefined`.
      yield* wedgeBranchRow(stack, undefined);

      yield* deleteBranchOutOfBand(
        initial.project.projectId,
        initial.branch.branchId,
      );

      const recovered = yield* deployBranch();
      expect(recovered.branch.branchId).toBeDefined();
      expect(recovered.branch.branchId).not.toEqual(initial.branch.branchId);
      expect(recovered.branch.projectId).toEqual(recovered.project.projectId);
      expect(recovered.branch.branchName).toEqual(initial.branch.branchName);

      const fetched = yield* getProjectBranch({
        project_id: recovered.project.projectId,
        branch_id: recovered.branch.branchId,
      });
      expect(fetched.branch.id).toEqual(recovered.branch.branchId);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

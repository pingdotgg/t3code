import { App as PrismaApp, AppProvider } from "@/Prisma/App";
import { PrismaClient, type PrismaManagementClient } from "@/Prisma/Client";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AlchemyContext } from "@/AlchemyContext";

const app = (id: string, branchId: string | null = "branch-main") => ({
  id,
  type: "app" as const,
  url: `https://api.prisma.test/v1/apps/${id}`,
  name: "api",
  region: { id: "us-east-1" as const, name: "US East" },
  projectId: "project-1",
  branchId,
  latestDeploymentId: null,
  appEndpointDomain: `${id}.prisma.build`,
  createdAt: "2026-01-01T00:00:00Z",
});

const branch = (id: string, isDefault = true) => ({
  id,
  type: "branch" as const,
  url: `https://api.prisma.test/v1/branches/${id}`,
  gitName: "main",
  isDefault,
  role: "production" as const,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  project: {
    id: "project-1",
    url: "https://api.prisma.test/v1/projects/project-1",
    name: "project",
  },
});

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const provide =
  (client: PrismaManagementClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(AppProvider()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(liveProviderContext),
    );

describe("Prisma App", () => {
  it.effect("replaces immutable drift and schedules only mutable drift", () => {
    let defaultBranchId = "branch-main";
    const client = {
      listBranches: () => Effect.succeed([branch(defaultBranchId, true)]),
    } as unknown as PrismaManagementClient;
    const output = {
      appId: "app-1",
      name: "api",
      projectId: "project-1",
      regionId: "us-east-1",
      branchId: "branch-main",
      latestDeploymentId: null,
      appEndpointDomain: "app-1.prisma.build",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const props = {
      project: "project-1",
      displayName: "api",
      regionId: "us-east-1" as const,
    };

    return Effect.gen(function* () {
      const provider = yield* PrismaApp.Provider;
      const base = {
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: props,
        news: props,
        oldBindings: [],
        newBindings: [],
      };
      const clean = yield* provider.diff!({ ...base, output } as never);
      const nameDrift = yield* provider.diff!({
        ...base,
        output: { ...output, name: "drifted" },
      } as never);
      defaultBranchId = "branch-next";
      const defaultBranchDrift = yield* provider.diff!({
        ...base,
        output,
      } as never);
      const wrongRegion = yield* provider.diff!({
        ...base,
        output: { ...output, regionId: "us-west-2" },
      } as never).pipe(Effect.result);
      const wrongProject = yield* provider.diff!({
        ...base,
        output: { ...output, projectId: "project-other" },
      } as never);

      expect(clean).toBeUndefined();
      expect(nameDrift).toEqual({ action: "update" });
      expect(defaultBranchDrift).toEqual({ action: "update" });
      expect(wrongRegion._tag).toBe("Failure");
      if (wrongRegion._tag === "Failure") {
        expect(String(wrongRegion.failure)).toContain(
          "cannot atomically move an App",
        );
      }
      expect(wrongProject).toEqual({ action: "replace" });
    }).pipe(provide(client));
  });

  it.effect("enumerates canonical Apps for unsafe nuke", () => {
    const client = {
      listApps: () => Effect.succeed([app("app-1"), app("app-2")]),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaApp.Provider;
      const apps = yield* provider.list!();
      expect(apps.map((item) => item.appId)).toEqual(["app-1", "app-2"]);
    }).pipe(provide(client));
  });

  it.effect("rejects an ambiguous natural ownership match", () => {
    const client = {
      listApps: () => Effect.succeed([app("app-1"), app("app-2")]),
      listBranches: () => Effect.succeed([branch("branch-main")]),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaApp.Provider;
      const error = yield* provider.read!({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: { project: "project-1", displayName: "api" },
        output: undefined,
      }).pipe(Effect.flip);
      expect((error as Error).message).toContain("ambiguous ownership match");
    }).pipe(provide(client));
  });

  it.effect(
    "inherits the project region and creates with a resolved branch ID",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const regionalApp = (id: string, branchId: string | null) => ({
        ...app(id, branchId),
        region: { id: "eu-west-3" as const, name: "Europe West" },
      });
      const client = {
        listBranches: () => Effect.succeed([branch("branch-wanted")]),
        createApp: (input: unknown) =>
          Effect.sync(() => {
            calls.push(["createApp", input]);
            return regionalApp("app-1", "branch-wrong");
          }),
        updateApp: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateApp", { id, input }]);
            return regionalApp(id, "branch-wanted");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaApp.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            displayName: "api",
            branchGitName: "main",
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(output.branchId).toBe("branch-wanted");
        expect(output.regionId).toBe("eu-west-3");
        expect(calls[0]).toEqual([
          "createApp",
          {
            projectId: "project-1",
            displayName: "api",
            regionId: undefined,
            branchId: "branch-wanted",
            branchGitName: undefined,
          },
        ]);
        expect(calls.map(([name]) => name)).toEqual(["createApp", "updateApp"]);
      }).pipe(provide(client));
    },
  );

  it.effect("repairs externally drifted mutable App state", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      getApp: () => Effect.succeed({ ...app("app-1"), name: "drifted" }),
      listBranches: () => Effect.succeed([branch("branch-main")]),
      updateApp: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateApp", { id, input }]);
          return app(id);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaApp.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: { project: "project-1", displayName: "api" },
        olds: { project: "project-1", displayName: "api" },
        output: {
          appId: "app-1",
          name: "api",
          projectId: "project-1",
          regionId: "us-east-1",
          branchId: "branch-main",
          latestDeploymentId: null,
          appEndpointDomain: "app-1.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.name).toBe("api");
      expect(calls.map(([name]) => name)).toEqual(["updateApp"]);
    }).pipe(provide(client));
  });

  it.effect("deletes by immutable identity despite mutable drift", () => {
    let deleted = false;
    const client = {
      getApp: () =>
        Effect.succeed({
          ...app("app-1", "branch-other"),
          name: "renamed-out-of-band",
        }),
      deleteApp: () =>
        Effect.sync(() => {
          deleted = true;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaApp.Provider;
      yield* provider.delete({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: { project: "project-1", displayName: "api" },
        output: {
          appId: "app-1",
          name: "api",
          projectId: "project-1",
          regionId: "us-east-1",
          branchId: "branch-main",
          latestDeploymentId: null,
          appEndpointDomain: "app-1.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        },
        session: undefined as never,
        bindings: [],
      });

      expect(deleted).toBe(true);
    }).pipe(provide(client));
  });

  it.effect(
    "refuses to patch an App with mismatched immutable identity",
    () => {
      let observed: Omit<ReturnType<typeof app>, "projectId" | "region"> & {
        projectId: string;
        region: { id: string; name: string };
      } = { ...app("app-1"), projectId: "project-other" };
      const client = {
        getApp: () => Effect.succeed(observed),
        updateApp: () => Effect.die("must not patch immutable identity drift"),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaApp.Provider;
        const reconcile = () =>
          provider.reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              displayName: "api",
              regionId: "us-east-1",
              branchId: "branch-main",
            },
            olds: undefined,
            output: {
              appId: "app-1",
              name: "api",
              projectId: "project-1",
              regionId: "us-east-1",
              branchId: "branch-main",
              latestDeploymentId: null,
              appEndpointDomain: "app-1.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            },
            session: undefined as never,
            bindings: [],
          });

        const projectError = yield* reconcile().pipe(Effect.flip);
        expect((projectError as Error).message).toContain("project-other");
        expect((projectError as Error).message).toContain("Refusing to patch");

        observed = {
          ...app("app-1"),
          region: { id: "us-west-2", name: "US West" },
        };
        const regionError = yield* reconcile().pipe(Effect.flip);
        expect((regionError as Error).message).toContain("us-west-2");
        expect((regionError as Error).message).toContain("Refusing to patch");
      }).pipe(provide(client));
    },
  );
});

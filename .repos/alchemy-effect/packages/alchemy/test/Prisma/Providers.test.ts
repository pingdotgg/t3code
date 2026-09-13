import { AlchemyContext } from "@/AlchemyContext";
import { AuthProviders } from "@/Auth/AuthProvider";
import * as CliKit from "@/Cli/CliKit";
import * as Provider from "@/Provider";
import * as Prisma from "@/Prisma";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { v4 as uuidv4 } from "uuid";

const devAlchemyContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: true,
  adopt: false,
});

const providePrismaDev = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Prisma.providers().pipe(
        // The dual registration always carries the (lazy) management-api
        // layer; it registers auth at build without resolving credentials.
        Layer.provideMerge(Layer.succeed(AuthProviders, {})),
      ),
    ),
    Effect.provide(devAlchemyContext),
    Effect.provide(CliKit.layer({ input: false })),
  );

const reconcileInput = (id: string, news: unknown, output?: unknown) =>
  ({
    id,
    instanceId: "00000000000000000000000000000000",
    news,
    olds: undefined,
    output,
    session: undefined as never,
    bindings: [],
  }) as never;

describe("Prisma providers", () => {
  it.effect(
    "registers Prisma auth without resolving credentials",
    () =>
      Effect.gen(function* () {
        const authProviders: AuthProviders["Service"] = {};

        yield* Layer.build(
          Prisma.providers().pipe(
            Layer.provideMerge(Layer.succeed(AuthProviders, authProviders)),
          ),
        );

        expect(authProviders.Prisma?.name).toBe("Prisma");
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CI: true,
            }),
          ),
        ),
        Effect.provide(
          Layer.succeed(AlchemyContext, {
            dotAlchemy: ".alchemy-test",
            dev: false,
            adopt: false,
          }),
        ),
        Effect.scoped,
      ),
    { timeout: 30_000 },
  );

  it.effect("registers every Prisma resource provider", () =>
    Effect.gen(function* () {
      const resourceTypes = [
        Prisma.Project.Type,
        Prisma.Database.Type,
        Prisma.Connection.Type,
        Prisma.Branch.Type,
        Prisma.Bucket.Type,
        Prisma.BucketAccessKey.Type,
        Prisma.Compute.Type,
        Prisma.App.Type,
        Prisma.Deployment.Type,
        Prisma.CustomDomain.Type,
        Prisma.EnvironmentVariable.Type,
        Prisma.SourceRepository.Type,
      ];
      const expectedStables = new Map([
        [Prisma.Project.Type, ["projectId"]],
        [Prisma.Database.Type, ["databaseId"]],
        [Prisma.Connection.Type, ["connectionId"]],
        [Prisma.Branch.Type, ["branchId"]],
        [Prisma.Bucket.Type, ["bucketId"]],
        [
          Prisma.BucketAccessKey.Type,
          [
            "bucketAccessKeyId",
            "bucketId",
            "accessKeyId",
            "secretAccessKey",
            "endpoint",
            "bucketName",
          ],
        ],
        [Prisma.Compute.Type, ["appId"]],
        [Prisma.App.Type, ["appId"]],
        [Prisma.Deployment.Type, ["deploymentId"]],
        [Prisma.CustomDomain.Type, ["customDomainId"]],
        [Prisma.EnvironmentVariable.Type, ["environmentVariableId"]],
        [Prisma.SourceRepository.Type, ["sourceRepositoryId"]],
      ]);

      const providers = yield* Effect.all(
        resourceTypes.map((type) => Provider.findProviderByType(type as any)),
        { concurrency: "unbounded" },
      );

      expect(providers).toHaveLength(resourceTypes.length);
      for (const provider of providers) {
        expect(typeof provider.reconcile).toBe("function");
        expect(typeof provider.delete).toBe("function");
        // ProviderLayer.dual registration: dev resolves the local variant
        // and exposes both variants for per-resource mode resolution.
        expect(provider.mode).toBe("local");
        expect(typeof provider.modes?.live).toBe("object");
        expect(typeof provider.modes?.local).toBe("object");
      }
      for (let i = 0; i < resourceTypes.length; i += 1) {
        expect(providers[i]?.stables).toEqual(
          expectedStables.get(resourceTypes[i]),
        );
      }
    }).pipe(providePrismaDev),
  );

  it.effect("uses tokenless dev providers from Prisma.providers()", () =>
    Effect.gen(function* () {
      const projectProvider = yield* Provider.findProviderByType(
        Prisma.Project.Type as any,
      );
      const appProvider = yield* Provider.findProviderByType(
        Prisma.App.Type as any,
      );
      const envProvider = yield* Provider.findProviderByType(
        Prisma.EnvironmentVariable.Type as any,
      );
      const branchProvider = yield* Provider.findProviderByType(
        Prisma.Branch.Type as any,
      );
      const bucketProvider = yield* Provider.findProviderByType(
        Prisma.Bucket.Type as any,
      );
      const bucketKeyProvider = yield* Provider.findProviderByType(
        Prisma.BucketAccessKey.Type as any,
      );

      const project = (yield* projectProvider.reconcile(
        reconcileInput("Project", {
          name: "local-project",
          createDatabase: false,
        }),
      )) as Prisma.Project["Attributes"];
      const app = (yield* appProvider.reconcile(
        reconcileInput("App", {
          project,
          displayName: "api",
          regionId: "us-east-1",
        }),
      )) as Prisma.App["Attributes"];
      const env = (yield* envProvider.reconcile(
        reconcileInput("Environment", {
          project,
          branchId: "branch-preview",
          class: "preview",
          key: "TOKEN",
          value: Redacted.make("secret"),
        }),
      )) as Prisma.EnvironmentVariable["Attributes"];
      const branch = (yield* branchProvider.reconcile(
        reconcileInput("Branch", {
          project,
          gitName: "main",
          isDefault: true,
        }),
      )) as Prisma.Branch["Attributes"];

      const bucket = (yield* bucketProvider.reconcile(
        reconcileInput("Bucket", { project, name: "uploads" }),
      )) as Prisma.Bucket["Attributes"];
      const bucketKey = (yield* bucketKeyProvider.reconcile(
        reconcileInput("BucketAccessKey", { bucket, role: "read_write" }),
      )) as Prisma.BucketAccessKey["Attributes"];

      expect(project.projectId).toBe("dev:project:Project");
      expect(app.projectId).toBe(project.projectId);
      expect(app.appId).toBe("dev:app:App");
      expect(env.projectId).toBe(project.projectId);
      expect(env.branchId).toBe("branch-preview");
      expect(Redacted.value(env.value)).toBe("secret");
      expect(branch.role).toBe("production");
      expect(bucket.bucketId).toBe("dev:bucket:Bucket");
      expect(bucket.name).toBe("uploads");
      expect(bucket.projectId).toBe(project.projectId);
      expect(bucketKey.bucketAccessKeyId).toBe(
        "dev:bucket-access-key:BucketAccessKey",
      );
      expect(bucketKey.bucketId).toBe(bucket.bucketId);
      expect(Redacted.isRedacted(bucketKey.secretAccessKey)).toBe(true);
    }).pipe(providePrismaDev),
  );

  it.effect("managementApi rejects an unknown explicit profile", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.sandbox(
          Effect.gen(function* () {
            yield* Prisma.PrismaClient;
          }).pipe(
            Effect.provide(Prisma.managementApi()),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
                }),
              ),
            ),
            Effect.provide(NodeServices.layer),
            Effect.provide(CliKit.layer({ input: false })),
          ),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("does not exist");
        expect(String(result.failure)).toContain("alchemy profile create");
      }
    }),
  );
});

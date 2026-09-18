import { AuthProviders } from "@/Auth/AuthProvider";
import { ProfileStore } from "@/Auth/Profile";
import * as CliKit from "@/Cli/CliKit";
import { PrismaAuth } from "@/Prisma/AuthProvider";
import { PrismaEnvironment, fromProfile } from "@/Prisma/PrismaEnvironment";
import { describe, expect, it } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeFakeProfileStore } from "./fakes.ts";

const makeProfile = (serviceToken: string): ProfileStore["Service"] =>
  makeFakeProfileStore({
    loadProviderConfig: <Config extends { method: string }>() =>
      Effect.succeed({ method: "stored", serviceToken } as unknown as Config),
  });

const testLayer = (
  config: Record<string, string>,
  options: {
    storedToken?: string;
  } = {},
) => {
  const authProviders: AuthProviders["Service"] = {};
  return fromProfile().pipe(
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(Layer.succeed(AuthProviders, authProviders)),
    Layer.provideMerge(
      Layer.succeed(
        ProfileStore,
        makeProfile(options.storedToken ?? "test-token"),
      ),
    ),
    Layer.provideMerge(
      ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(CliKit.layer({ input: false })),
  );
};

describe("PrismaEnvironment", () => {
  it.effect("resolves stored credentials and API base URL from config", () =>
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;

      expect(env.type).toBe("serviceToken");
      expect(env.source).toEqual({ type: "stored" });
      expect(Redacted.value(env.serviceToken)).toBe("test-token");
      expect(env.baseUrl).toBe("https://control-plane.prisma.test");
    }).pipe(
      Effect.provide(
        testLayer(
          { PRISMA_API_URL: "https://control-plane.prisma.test" },
          { storedToken: "test-token" },
        ),
      ),
    ),
  );

  it.effect("prefers PRISMA_API_URL over PRISMA_MANAGEMENT_API_URL", () =>
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;

      expect(env.baseUrl).toBe("https://api-url.prisma.test");
    }).pipe(
      Effect.provide(
        testLayer(
          {
            PRISMA_API_URL: "https://api-url.prisma.test",
            PRISMA_MANAGEMENT_API_URL: "https://management-url.prisma.test",
          },
          { storedToken: "test-token" },
        ),
      ),
    ),
  );

  it.effect("resolves stored profile credentials", () =>
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;

      expect(env.type).toBe("serviceToken");
      expect(env.source).toEqual({ type: "stored" });
      expect(Redacted.value(env.serviceToken)).toBe("stored-token");
      expect(env.baseUrl).toBe("https://api.prisma.io");
    }).pipe(
      Effect.provide(
        testLayer(
          {},
          {
            storedToken: "stored-token",
          },
        ),
      ),
    ),
  );

  it.effect("allows HTTP only for loopback Management API URLs", () =>
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;
      expect(env.baseUrl).toBe("http://127.0.0.1:8787");
    }).pipe(
      Effect.provide(
        testLayer(
          { PRISMA_API_URL: "http://127.0.0.1:8787/" },
          { storedToken: "test-token" },
        ),
      ),
    ),
  );

  it.effect("rejects insecure remote Management API URLs", () =>
    Effect.gen(function* () {
      const exit = yield* PrismaEnvironment.pipe(
        Effect.provide(
          testLayer(
            { PRISMA_API_URL: "http://management.prisma.test" },
            { storedToken: "test-token" },
          ),
        ),
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("must use HTTPS");
      }
    }),
  );

  it.effect("rejects Management API URLs with credentials or path state", () =>
    Effect.gen(function* () {
      const credentialExit = yield* PrismaEnvironment.pipe(
        Effect.provide(
          testLayer(
            { PRISMA_API_URL: "https://token@api.prisma.test" },
            { storedToken: "test-token" },
          ),
        ),
        Effect.exit,
      );
      expect(credentialExit._tag).toBe("Failure");
      if (credentialExit._tag === "Failure") {
        expect(String(credentialExit.cause)).toContain(
          "must not contain credentials",
        );
      }

      const pathExit = yield* PrismaEnvironment.pipe(
        Effect.provide(
          testLayer(
            { PRISMA_API_URL: "https://api.prisma.test/proxy" },
            { storedToken: "test-token" },
          ),
        ),
        Effect.exit,
      );
      expect(pathExit._tag).toBe("Failure");
      if (pathExit._tag === "Failure") {
        expect(String(pathExit.cause)).toContain("must be an origin");
      }
    }),
  );
});

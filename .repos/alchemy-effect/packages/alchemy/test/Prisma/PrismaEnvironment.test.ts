import { AuthProviders } from "@/Auth/AuthProvider";
import { CredentialsStore } from "@/Auth/Credentials";
import { AlchemyProfile } from "@/Auth/Profile";
import {
  PrismaAuth,
  type PrismaStoredCredentials,
} from "@/Prisma/AuthProvider";
import { PrismaEnvironment, fromProfile } from "@/Prisma/PrismaEnvironment";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const makeProfile = (method: "env" | "stored"): AlchemyProfile["Service"] => ({
  readConfig: Effect.succeed({ version: 0, profiles: {} }),
  writeConfig: () => Effect.void,
  getProfile: () => Effect.succeed(undefined),
  setProfile: () => Effect.void,
  deleteProfile: () => Effect.succeed(false),
  loadOrConfigure: <Config extends { method: string }>() =>
    Effect.succeed({ method } as Config),
});

const makeCredentialsStore = (
  serviceToken?: string,
): CredentialsStore["Service"] => {
  const stored = serviceToken
    ? ({
        type: "serviceToken",
        serviceToken,
      } satisfies PrismaStoredCredentials)
    : undefined;
  return {
    read: <T>() => Effect.succeed(stored as T | undefined),
    write: () => Effect.void,
    delete: () => Effect.void,
    deleteProfile: () => Effect.void,
  };
};

const testLayer = (
  config: Record<string, string>,
  options: {
    method?: "env" | "stored";
    storedToken?: string;
  } = {},
) => {
  const authProviders: AuthProviders["Service"] = {};
  return fromProfile().pipe(
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(Layer.succeed(AuthProviders, authProviders)),
    Layer.provideMerge(
      Layer.succeed(AlchemyProfile, makeProfile(options.method ?? "env")),
    ),
    Layer.provideMerge(
      Layer.succeed(
        CredentialsStore,
        makeCredentialsStore(options.storedToken),
      ),
    ),
    Layer.provideMerge(
      ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
    ),
  );
};

describe("PrismaEnvironment", () => {
  it.effect("resolves credentials and API base URL from profile config", () =>
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;

      expect(env.type).toBe("serviceToken");
      expect(env.source).toEqual({
        type: "env",
        details: "PRISMA_SERVICE_TOKEN",
      });
      expect(Redacted.value(env.serviceToken)).toBe("test-token");
      expect(env.baseUrl).toBe("https://control-plane.prisma.test");
    }).pipe(
      Effect.provide(
        testLayer({
          PRISMA_SERVICE_TOKEN: "test-token",
          PRISMA_API_URL: "https://control-plane.prisma.test",
        }),
      ),
    ),
  );

  it.effect("resolves Prisma Compute CLI env aliases", () =>
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;

      expect(env.type).toBe("serviceToken");
      expect(env.source).toEqual({
        type: "env",
        details: "PRISMA_API_TOKEN",
      });
      expect(Redacted.value(env.serviceToken)).toBe("api-token");
      expect(env.baseUrl).toBe("https://management.prisma.test");
    }).pipe(
      Effect.provide(
        testLayer({
          PRISMA_API_TOKEN: "api-token",
          PRISMA_MANAGEMENT_API_URL: "https://management.prisma.test",
        }),
      ),
    ),
  );

  it.effect("prefers PRISMA_API_URL over PRISMA_MANAGEMENT_API_URL", () =>
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;

      expect(env.baseUrl).toBe("https://api-url.prisma.test");
    }).pipe(
      Effect.provide(
        testLayer({
          PRISMA_SERVICE_TOKEN: "test-token",
          PRISMA_API_URL: "https://api-url.prisma.test",
          PRISMA_MANAGEMENT_API_URL: "https://management-url.prisma.test",
        }),
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
            method: "stored",
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
        testLayer({
          PRISMA_SERVICE_TOKEN: "test-token",
          PRISMA_API_URL: "http://127.0.0.1:8787/",
        }),
      ),
    ),
  );

  it.effect("rejects insecure remote Management API URLs", () =>
    Effect.gen(function* () {
      const exit = yield* PrismaEnvironment.pipe(
        Effect.provide(
          testLayer({
            PRISMA_SERVICE_TOKEN: "test-token",
            PRISMA_API_URL: "http://management.prisma.test",
          }),
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
          testLayer({
            PRISMA_SERVICE_TOKEN: "test-token",
            PRISMA_API_URL: "https://token@api.prisma.test",
          }),
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
          testLayer({
            PRISMA_SERVICE_TOKEN: "test-token",
            PRISMA_API_URL: "https://api.prisma.test/proxy",
          }),
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

import {
  PRISMA_AUTH_PROVIDER_NAME,
  PrismaAuth,
  type PrismaAuthConfig,
  type PrismaResolvedCredentials,
  type PrismaStoredCredentials,
} from "@/Prisma/AuthProvider";
import { AuthProviders, getAuthProvider } from "@/Auth/AuthProvider";
import { CredentialsStore } from "@/Auth/Credentials";
import { AlchemyProfile } from "@/Auth/Profile";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const fakeProfile: AlchemyProfile["Service"] = {
  readConfig: Effect.succeed({ version: 0, profiles: {} }),
  writeConfig: () => Effect.void,
  getProfile: () => Effect.succeed(undefined),
  setProfile: () => Effect.void,
  deleteProfile: () => Effect.succeed(false),
  loadOrConfigure: <Config extends { method: string }>() =>
    Effect.succeed({ method: "env" } as Config),
};

const makeCredentialsStore = (
  stored?: PrismaStoredCredentials,
): CredentialsStore["Service"] => ({
  read: <T>() => Effect.succeed(stored as T | undefined),
  write: () => Effect.void,
  delete: () => Effect.void,
  deleteProfile: () => Effect.void,
});

const testLayer = (
  config: Record<string, string> = {},
  stored?: PrismaStoredCredentials,
) => {
  const authProviders: AuthProviders["Service"] = {};
  const authRegistry = Layer.succeed(AuthProviders, authProviders);
  const base = Layer.mergeAll(
    authRegistry,
    Layer.succeed(AlchemyProfile, fakeProfile),
    Layer.succeed(CredentialsStore, makeCredentialsStore(stored)),
    ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
  );
  return PrismaAuth.pipe(Layer.provideMerge(base));
};

const readEnvCredentials = Effect.gen(function* () {
  const auth = yield* getAuthProvider<
    PrismaAuthConfig,
    PrismaResolvedCredentials
  >(PRISMA_AUTH_PROVIDER_NAME);
  return yield* auth.read("default", { method: "env" });
});

const readStoredCredentials = Effect.gen(function* () {
  const auth = yield* getAuthProvider<
    PrismaAuthConfig,
    PrismaResolvedCredentials
  >(PRISMA_AUTH_PROVIDER_NAME);
  return yield* auth.read("default", { method: "stored" });
});

describe("Prisma auth provider", () => {
  it.effect("reads Prisma service tokens from PRISMA_SERVICE_TOKEN", () =>
    Effect.gen(function* () {
      const credentials = yield* readEnvCredentials;

      expect(credentials.type).toBe("serviceToken");
      expect(credentials.source).toEqual({
        type: "env",
        details: "PRISMA_SERVICE_TOKEN",
      });
      expect(Redacted.value(credentials.serviceToken)).toBe("test-token");
    }).pipe(
      Effect.provide(
        testLayer({
          PRISMA_SERVICE_TOKEN: "test-token",
        }),
      ),
    ),
  );

  it.effect("reads Prisma service tokens from PRISMA_API_TOKEN", () =>
    Effect.gen(function* () {
      const credentials = yield* readEnvCredentials;

      expect(credentials.type).toBe("serviceToken");
      expect(credentials.source).toEqual({
        type: "env",
        details: "PRISMA_API_TOKEN",
      });
      expect(Redacted.value(credentials.serviceToken)).toBe("api-token");
    }).pipe(
      Effect.provide(
        testLayer({
          PRISMA_API_TOKEN: "api-token",
        }),
      ),
    ),
  );

  it.effect("trims surrounding token whitespace", () =>
    Effect.gen(function* () {
      const credentials = yield* readEnvCredentials;
      expect(Redacted.value(credentials.serviceToken)).toBe("test-token");
    }).pipe(
      Effect.provide(
        testLayer({
          PRISMA_SERVICE_TOKEN: "  test-token\n",
        }),
      ),
    ),
  );

  it.effect(
    "prefers PRISMA_SERVICE_TOKEN when both token env vars are set",
    () =>
      Effect.gen(function* () {
        const credentials = yield* readEnvCredentials;

        expect(credentials.type).toBe("serviceToken");
        expect(credentials.source).toEqual({
          type: "env",
          details: "PRISMA_SERVICE_TOKEN",
        });
        expect(Redacted.value(credentials.serviceToken)).toBe("service-token");
      }).pipe(
        Effect.provide(
          testLayer({
            PRISMA_SERVICE_TOKEN: "service-token",
            PRISMA_API_TOKEN: "api-token",
          }),
        ),
      ),
  );

  it.effect(
    "falls back to PRISMA_API_TOKEN when PRISMA_SERVICE_TOKEN is empty",
    () =>
      Effect.gen(function* () {
        const credentials = yield* readEnvCredentials;

        expect(credentials.type).toBe("serviceToken");
        expect(credentials.source).toEqual({
          type: "env",
          details: "PRISMA_API_TOKEN",
        });
        expect(Redacted.value(credentials.serviceToken)).toBe("api-token");
      }).pipe(
        Effect.provide(
          testLayer({
            PRISMA_SERVICE_TOKEN: "   ",
            PRISMA_API_TOKEN: "api-token",
          }),
        ),
      ),
  );

  it.effect("fails clearly when PRISMA_SERVICE_TOKEN is missing", () =>
    Effect.gen(function* () {
      const exit = yield* readEnvCredentials.pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "Set PRISMA_SERVICE_TOKEN or PRISMA_API_TOKEN",
        );
      }
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("treats an empty PRISMA_SERVICE_TOKEN as missing", () =>
    Effect.gen(function* () {
      const exit = yield* readEnvCredentials.pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "Set PRISMA_SERVICE_TOKEN or PRISMA_API_TOKEN",
        );
      }
    }).pipe(Effect.provide(testLayer({ PRISMA_SERVICE_TOKEN: "   " }))),
  );

  it.effect(
    "reads stored Prisma service tokens from the credentials store",
    () =>
      Effect.gen(function* () {
        const credentials = yield* readStoredCredentials;

        expect(credentials.type).toBe("serviceToken");
        expect(credentials.source).toEqual({ type: "stored" });
        expect(Redacted.value(credentials.serviceToken)).toBe("stored-token");
      }).pipe(
        Effect.provide(
          testLayer(
            {},
            {
              type: "serviceToken",
              serviceToken: "stored-token",
            },
          ),
        ),
      ),
  );

  it.effect("fails clearly when stored Prisma credentials are missing", () =>
    Effect.gen(function* () {
      const exit = yield* readStoredCredentials.pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "Prisma stored credentials not found",
        );
      }
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rejects empty stored Prisma service tokens", () =>
    Effect.gen(function* () {
      const exit = yield* readStoredCredentials.pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain(
          "Prisma stored credentials are invalid",
        );
      }
    }).pipe(
      Effect.provide(
        testLayer({}, { type: "serviceToken", serviceToken: "   " }),
      ),
    ),
  );
});

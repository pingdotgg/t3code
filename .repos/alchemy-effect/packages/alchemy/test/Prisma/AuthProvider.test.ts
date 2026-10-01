import { AuthProviders, getAuthProvider } from "@/Auth/AuthProvider";
import { ProfileStore } from "@/Auth/Profile";
import * as Interaction from "@/Interaction.ts";
import {
  PRISMA_AUTH_PROVIDER_NAME,
  PrismaAuth,
  type PrismaAuthConfig,
  type PrismaResolvedCredentials,
} from "@/Prisma/AuthProvider";
import { describe, expect, it } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeFakeProfileStore } from "./fakes.ts";

const fakeProfile = makeFakeProfileStore();

const testLayer = (config: Record<string, string> = {}) => {
  const authProviders: AuthProviders["Service"] = {};
  const authRegistry = Layer.succeed(AuthProviders, authProviders);
  const base = Layer.mergeAll(
    NodeServices.layer,
    authRegistry,
    Layer.succeed(ProfileStore, fakeProfile),
    ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
    Interaction.layerNonInteractive(),
  );
  return PrismaAuth.pipe(Layer.provideMerge(base));
};

const prismaAuthProvider = getAuthProvider<
  PrismaAuthConfig,
  PrismaResolvedCredentials
>(PRISMA_AUTH_PROVIDER_NAME);

const readStoredCredentials = Effect.gen(function* () {
  const auth = yield* prismaAuthProvider;
  return yield* auth.read("default", {
    method: "stored",
    serviceToken: "stored-token",
  });
});

const readEnvironmentCredentials = Effect.gen(function* () {
  const auth = yield* prismaAuthProvider;
  if (auth.readEnvironment === undefined) {
    return yield* Effect.die(
      "Prisma does not expose CI environment credentials",
    );
  }
  return yield* auth.readEnvironment;
});

describe("Prisma auth provider", () => {
  it.effect("reads PRISMA_SERVICE_TOKEN for CI", () =>
    Effect.gen(function* () {
      const credentials = yield* readEnvironmentCredentials;
      expect(credentials.source).toEqual({
        type: "env",
        details: "PRISMA_SERVICE_TOKEN",
      });
      expect(Redacted.value(credentials.serviceToken)).toBe("service-token");
    }).pipe(
      Effect.provide(testLayer({ PRISMA_SERVICE_TOKEN: "service-token" })),
    ),
  );

  it.effect("falls back to PRISMA_API_TOKEN for CI", () =>
    Effect.gen(function* () {
      const credentials = yield* readEnvironmentCredentials;
      expect(credentials.source).toEqual({
        type: "env",
        details: "PRISMA_API_TOKEN",
      });
      expect(Redacted.value(credentials.serviceToken)).toBe("api-token");
    }).pipe(Effect.provide(testLayer({ PRISMA_API_TOKEN: "api-token" }))),
  );

  it.effect("reads inline stored Prisma service tokens", () =>
    Effect.gen(function* () {
      const credentials = yield* readStoredCredentials;

      expect(credentials.type).toBe("serviceToken");
      expect(credentials.source).toEqual({ type: "stored" });
      expect(Redacted.value(credentials.serviceToken)).toBe("stored-token");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("returns redacted details for stored credentials", () =>
    Effect.gen(function* () {
      const auth = yield* prismaAuthProvider;
      const details = yield* auth.details("default", {
        method: "stored",
        serviceToken: "stored-token",
      });

      expect(details.lines).toEqual([
        { key: "serviceToken", value: "stor****" },
      ]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rejects whitespace-only service tokens in configureWith", () =>
    Effect.gen(function* () {
      const auth = yield* prismaAuthProvider;
      if (auth.configureWith === undefined) {
        return yield* Effect.die(
          "Prisma does not expose flag-driven configuration",
        );
      }
      const error = yield* auth
        .configureWith("default", {
          method: "stored",
          values: { serviceToken: "   " },
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("invalid 'serviceToken'");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("declares the stored configure method", () =>
    Effect.gen(function* () {
      const auth = yield* prismaAuthProvider;

      expect(auth.configureMethods).toEqual([
        {
          method: "stored",
          fields: [
            expect.objectContaining({
              name: "serviceToken",
              label: "Prisma Service Token",
              secret: true,
            }),
          ],
        },
      ]);
    }).pipe(Effect.provide(testLayer())),
  );
});

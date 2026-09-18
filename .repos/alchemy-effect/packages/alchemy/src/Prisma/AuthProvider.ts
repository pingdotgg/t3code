import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnvRedacted } from "../Auth/Env.ts";
import {
  makeStoredAuthProvider,
  storedSecret,
  type StoredAuthConfig,
} from "../Auth/StoredAuthProvider.ts";

export const PRISMA_AUTH_PROVIDER_NAME = "Prisma";

export type PrismaAuthConfig = StoredAuthConfig;

export interface PrismaResolvedCredentials {
  type: "serviceToken";
  serviceToken: Redacted.Redacted<string>;
  source: { type: PrismaAuthConfig["method"] | "env"; details?: string };
}

const prismaAuth = makeStoredAuthProvider<PrismaResolvedCredentials>({
  provider: PRISMA_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "serviceToken",
      label: "Prisma Service Token",
      secret: true,
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
  ],
  toResolved: (values) => ({
    type: "serviceToken",
    serviceToken: storedSecret(values.serviceToken) ?? Redacted.make(""),
    source: { type: "stored" },
  }),
  readEnvironment: Effect.gen(function* () {
    const serviceToken = yield* getEnvRedacted("PRISMA_SERVICE_TOKEN");
    const apiToken = yield* getEnvRedacted("PRISMA_API_TOKEN");
    const token = serviceToken ?? apiToken;
    if (token === undefined || Redacted.value(token).trim().length === 0) {
      return yield* new AuthError({
        message:
          "Prisma CI credentials not found. Set PRISMA_SERVICE_TOKEN or PRISMA_API_TOKEN.",
      });
    }
    return {
      type: "serviceToken" as const,
      serviceToken: Redacted.make(Redacted.value(token).trim()),
      source: {
        type: "env" as const,
        details:
          serviceToken === undefined
            ? "PRISMA_API_TOKEN"
            : "PRISMA_SERVICE_TOKEN",
      },
    };
  }),
  environment: [
    {
      name: "PRISMA_SERVICE_TOKEN",
      required: true,
      secret: true,
      alternatives: ["PRISMA_API_TOKEN"],
      description: "Prisma Platform service token.",
    },
    {
      name: "PRISMA_API_URL",
      required: false,
      alternatives: ["PRISMA_MANAGEMENT_API_URL"],
      description: "Management API base URL override.",
    },
  ],
});

/**
 * Layer that registers the Prisma Management API auth provider.
 */
export const PrismaAuth = prismaAuth.layer;

/** Schema of Prisma's inline static-token values. */
export const PrismaStoredCredentials = prismaAuth.storedSchema;
export type PrismaStoredCredentials = typeof PrismaStoredCredentials.Type;

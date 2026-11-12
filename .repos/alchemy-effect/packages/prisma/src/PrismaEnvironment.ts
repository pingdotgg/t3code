import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PRISMA_AUTH_PROVIDER_NAME,
  type PrismaAuthConfig,
  type PrismaResolvedCredentials,
} from "./AuthProvider.ts";
import { resolveBaseUrl } from "./internal/BaseUrl.ts";

export interface PrismaEnvironmentShape extends PrismaResolvedCredentials {
  baseUrl: string;
}

export class PrismaEnvironment extends Context.Service<PrismaEnvironment, PrismaEnvironmentShape>()(
  "Prisma::PrismaEnvironment",
) {}

export const fromProfile = () =>
  Layer.effect(
    PrismaEnvironment,
    Effect.gen(function* () {
      const baseUrl = yield* resolveBaseUrl;
      const { resolve } = yield* resolveProviderConfig<PrismaAuthConfig, PrismaResolvedCredentials>(
        PRISMA_AUTH_PROVIDER_NAME,
      );
      const credentials = yield* resolve;
      return { ...credentials, baseUrl };
    }),
  );

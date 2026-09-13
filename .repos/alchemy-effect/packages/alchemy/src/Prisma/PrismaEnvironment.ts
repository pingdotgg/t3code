import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  PRISMA_AUTH_PROVIDER_NAME,
  type PrismaAuthConfig,
  type PrismaResolvedCredentials,
} from "./AuthProvider.ts";

export interface PrismaEnvironmentShape extends PrismaResolvedCredentials {
  baseUrl: string;
}

export class PrismaEnvironment extends Context.Service<
  PrismaEnvironment,
  PrismaEnvironmentShape
>()("Prisma::PrismaEnvironment") {}

const DEFAULT_BASE_URL = "https://api.prisma.io";
const PRISMA_API_URL_ENV = "PRISMA_API_URL";
const PRISMA_MANAGEMENT_API_URL_ENV = "PRISMA_MANAGEMENT_API_URL";

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

const normalizeBaseUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Prisma Management API URL must use HTTP or HTTPS.");
      }
      if (url.username.length > 0 || url.password.length > 0) {
        throw new Error(
          "Prisma Management API URL must not contain credentials.",
        );
      }
      if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        throw new Error(
          "Prisma Management API URL must use HTTPS unless it targets a loopback host.",
        );
      }
      if (
        (url.pathname !== "/" && url.pathname !== "") ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        throw new Error(
          "Prisma Management API URL must be an origin without a path, query, or fragment.",
        );
      }
      return url.origin;
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Invalid Prisma Management API URL: ${String(cause)}`),
  });

export const fromProfile = () =>
  Layer.effect(
    PrismaEnvironment,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        PrismaAuthConfig,
        PrismaResolvedCredentials
      >(PRISMA_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const baseUrl = yield* Config.string(PRISMA_API_URL_ENV).pipe(
        Config.orElse(() => Config.string(PRISMA_MANAGEMENT_API_URL_ENV)),
        Config.withDefault(DEFAULT_BASE_URL),
        Effect.flatMap(normalizeBaseUrl),
      );
      const config = yield* profile.loadOrConfigure(auth, profileName, { ci });
      const credentials = yield* auth.read(
        profileName,
        config as PrismaAuthConfig,
      );
      return { ...credentials, baseUrl };
    }),
  );

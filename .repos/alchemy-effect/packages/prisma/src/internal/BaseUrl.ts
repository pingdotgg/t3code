import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const DEFAULT_BASE_URL = "https://api.prisma.io";
const PRISMA_API_URL_ENV = "PRISMA_API_URL";
const PRISMA_MANAGEMENT_API_URL_ENV = "PRISMA_MANAGEMENT_API_URL";

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

export class InvalidBaseUrlError extends Data.TaggedError("InvalidBaseUrlError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const normalizeBaseUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Prisma Management API URL must use HTTP or HTTPS.");
      }
      if (url.username.length > 0 || url.password.length > 0) {
        throw new Error("Prisma Management API URL must not contain credentials.");
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
      new InvalidBaseUrlError({
        message:
          cause instanceof Error
            ? cause.message
            : `Invalid Prisma Management API URL: ${String(cause)}`,
        cause,
      }),
  });

/** The Management API origin: `PRISMA_API_URL`, `PRISMA_MANAGEMENT_API_URL`, or the default. */
export const resolveBaseUrl = Config.String(PRISMA_API_URL_ENV).pipe(
  Config.orElse(() => Config.String(PRISMA_MANAGEMENT_API_URL_ENV)),
  Config.withDefault(DEFAULT_BASE_URL),
  Effect.flatMap(normalizeBaseUrl),
);

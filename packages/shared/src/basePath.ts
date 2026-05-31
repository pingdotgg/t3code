import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class BasePathParseError extends Data.TaggedError("BasePathParseError")<{
  readonly value: string;
}> {
  override get message(): string {
    return `Invalid base path: ${this.value || "<empty>"}`;
  }
}

export type NormalizedBasePath = Brand.Branded<string, "NormalizedBasePath">;
export const NormalizedBasePath = Brand.nominal<NormalizedBasePath>();
export const ROOT_BASE_PATH: NormalizedBasePath = NormalizedBasePath("");

export const normalizeBasePath = (
  rawValue: string | null | undefined,
): Effect.Effect<NormalizedBasePath, BasePathParseError> =>
  Effect.suspend(() => {
    const value = rawValue?.trim() ?? "";
    if (value.length === 0 || value === "/") {
      return Effect.succeed(ROOT_BASE_PATH);
    }

    if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
      return Effect.fail(new BasePathParseError({ value }));
    }

    const normalized = value.replace(/\/+$/u, "");
    const segments = normalized.slice(1).split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      return Effect.fail(new BasePathParseError({ value }));
    }

    return Effect.succeed(NormalizedBasePath(normalized));
  });

export function stripBasePathFromPathname(
  basePath: NormalizedBasePath,
  pathname: string,
): string | null {
  if (basePath === "") {
    return pathname.startsWith("/") ? pathname : `/${pathname}`;
  }
  if (pathname === basePath) {
    return "/";
  }
  if (pathname.startsWith(`${basePath}/`)) {
    const stripped = pathname.slice(basePath.length);
    return stripped.length === 0 ? "/" : stripped;
  }
  return null;
}

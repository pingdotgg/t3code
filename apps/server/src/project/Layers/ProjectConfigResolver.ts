import {
  PROJECT_CONFIG_RELATIVE_PATH,
  ProjectConfig,
  type ProjectScript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ProjectConfigResolver,
  type ProjectConfigResolverShape,
} from "../Services/ProjectConfigResolver.ts";

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//iu;
const LOCAL_PORT_URL_PATTERN = /^:\d{1,5}(?:[/?#]|$)/u;

function looksLikeBareHttpUrl(rawUrl: string): boolean {
  const authority = rawUrl.match(/^[^/?#]+/u)?.[0] ?? "";
  if (!authority || authority.includes("@")) {
    return false;
  }
  if (/^\[[^\]]+\](?::\d{1,5})?$/u.test(authority)) {
    return true;
  }

  return (
    /^[a-z\d.-]+(?::\d{1,5})?$/iu.test(authority) &&
    (/[.:]/u.test(authority) || authority.toLowerCase() === "localhost")
  );
}

function normalizePreviewUrl(rawUrl: string | undefined): string | null | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (LOCAL_PORT_URL_PATTERN.test(trimmed)) {
    return `http://localhost${trimmed}`;
  }
  if (trimmed.startsWith("//")) {
    return `http:${trimmed}`;
  }
  if (ABSOLUTE_URL_PATTERN.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }
  if (looksLikeBareHttpUrl(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function hasDuplicateScriptIds(scripts: readonly ProjectScript[]): boolean {
  const ids = new Set<string>();
  for (const script of scripts) {
    if (ids.has(script.id)) return true;
    ids.add(script.id);
  }
  return false;
}

export const makeProjectConfigResolver = Effect.gen(function* () {
  const resolveProjectConfig = yield* makeProjectConfigResolverFunction;

  const resolve: ProjectConfigResolverShape["resolve"] = (input) => resolveProjectConfig(input);

  return { resolve } satisfies ProjectConfigResolverShape;
});

export const makeProjectConfigResolverFunction = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
  const decodeProjectConfig = Schema.decodeUnknownEffect(ProjectConfig);

  return Effect.fn("ProjectConfigResolver.resolve")(function* ({ cwd }: { readonly cwd: string }) {
    const configPath = path.join(cwd, PROJECT_CONFIG_RELATIVE_PATH);
    const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return {};
    }

    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to read project config", {
          configPath,
          error,
        }).pipe(Effect.as(null)),
      ),
    );
    if (raw === null) {
      return {};
    }

    const parsed = yield* decodeJsonString(raw).pipe(
      Effect.catch((error) =>
        Effect.logWarning("invalid project config JSON", {
          configPath,
          error,
        }).pipe(Effect.as(null)),
      ),
    );
    if (parsed === null) {
      return {};
    }

    const config = yield* decodeProjectConfig(parsed).pipe(
      Effect.catch((error) =>
        Effect.logWarning("invalid project config schema", {
          configPath,
          error,
        }).pipe(Effect.as(null)),
      ),
    );
    if (config === null) {
      return {};
    }

    const browserPreviewUrl = normalizePreviewUrl(config.browser?.previewUrl);
    const scripts =
      config.scripts === undefined
        ? undefined
        : hasDuplicateScriptIds(config.scripts)
          ? yield* Effect.logWarning("invalid project config scripts: duplicate ids", {
              configPath,
            }).pipe(Effect.as(undefined))
          : [...config.scripts];

    return {
      ...(scripts !== undefined ? { scripts } : {}),
      ...(browserPreviewUrl !== undefined ? { browserPreviewUrl } : {}),
    };
  });
});

export const ProjectConfigResolverLive = Layer.effect(
  ProjectConfigResolver,
  makeProjectConfigResolver,
);

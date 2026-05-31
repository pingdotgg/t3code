import * as Effect from "effect/Effect";

import {
  ROOT_BASE_PATH,
  normalizeBasePath,
  type NormalizedBasePath,
} from "@t3tools/shared/basePath";

function resolveRuntimeBasePath(): NormalizedBasePath {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol !== "http:" && moduleUrl.protocol !== "https:") {
    return ROOT_BASE_PATH;
  }
  return Effect.runSync(normalizeBasePath(new URL("..", moduleUrl).pathname));
}

export const BASE_PATH = resolveRuntimeBasePath();

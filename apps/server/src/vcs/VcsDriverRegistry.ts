import { Cache, Context, Duration, Effect, Exit, Layer } from "effect";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@t3tools/contracts";
import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import type { VcsDriverShape } from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
const DETECTION_CACHE_TTL = Duration.seconds(2);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriverShape;
}

export interface VcsDriverRegistryShape {
  readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriverShape, VcsError>;
  readonly detect: (
    input: VcsDriverResolveInput,
  ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
  readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
}

export class VcsDriverRegistry extends Context.Service<VcsDriverRegistry, VcsDriverRegistryShape>()(
  "t3/vcs/VcsDriverRegistry",
) {}

const unsupported = (operation: string, kind: VcsDriverKind, detail: string) =>
  new VcsUnsupportedOperationError({
    operation,
    kind,
    detail,
  });

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return {
      cwd: key,
      requestedKind: "auto",
    };
  }
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.fn("makeVcsDriverRegistry")(function* () {
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriverShape();
  const jj = yield* JjVcsDriver.makeVcsDriverShape();
  const drivers: Partial<Record<VcsDriverKind, VcsDriverShape>> = {
    git,
    jj,
  };

  const get: VcsDriverRegistryShape["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        unsupported("VcsDriverRegistry.get", kind, `No ${kind} VCS driver is registered.`),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriverShape,
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    const jjDetected = yield* detectWithDriver("jj", jj, input.cwd);
    if (jjDetected) {
      return jjDetected;
    }

    return yield* detectWithDriver("git", git, input.cwd);
  });

  const detectionCache = yield* Cache.makeWith<string, VcsDriverHandle | null, VcsError>(
    (key) => detectResolvedKind(parseDetectionCacheKey(key)),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETECTION_CACHE_TTL : Duration.zero),
    },
  );

  const detect: VcsDriverRegistryShape["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = yield* projectConfig.resolveKind(input);
      return yield* Cache.get(detectionCache, detectionCacheKey({ cwd: input.cwd, requestedKind }));
    },
  );

  const resolve: VcsDriverRegistryShape["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* unsupported(
        "VcsDriverRegistry.resolve",
        requestedKind === "auto" ? "unknown" : requestedKind,
        requestedKind === "auto"
          ? `No supported VCS repository was detected at ${input.cwd}.`
          : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      );
    },
  );

  return VcsDriverRegistry.of({
    get,
    detect,
    resolve,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make()).pipe(
  Layer.provide(VcsProjectConfig.layer),
);

import { type AntigravitySettings, ProviderInstanceId, UsageReadError } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type {
  ProviderUsageInstance,
  ProviderUsageReader,
  ProviderUsageScan,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAntigravityInstanceDirectories } from "../antigravityAuthSupport.ts";
import {
  antigravityRateModel,
  makeAntigravityUsageCache,
  readAntigravityUsage,
} from "./antigravityUsageReader.ts";

export class AntigravityUsage extends Context.Service<
  AntigravityUsage,
  {
    readonly scan: (input: {
      readonly instances: ReadonlyArray<ProviderUsageInstance<AntigravitySettings>>;
      /** Configured instances that are off or not allowed; their T3-managed profiles stay unread. */
      readonly unreadInstanceIds: ReadonlyArray<ProviderInstanceId>;
      readonly windowStartMs: number;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>, UsageReadError>;
  }
>()("t3/provider/Drivers/AntigravityUsage") {}

const make = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const cache = makeAntigravityUsageCache();

  const dataRoots = Effect.fn("AntigravityUsage.dataRoots")(function* (
    environment: NodeJS.ProcessEnv,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const configured = environment["ANTIGRAVITY_DATA_DIR"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const defaults = [
      ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
        path.join(home, ".gemini", name),
      ),
      path.join(home, ".config", "antigravity"),
    ];
    const canonical = new Set<string>();
    for (const root of configured?.length ? configured : defaults) {
      const resolved = path.resolve(expandHomePath(root, home));
      canonical.add(
        yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)),
      );
    }
    return [...canonical];
  });

  const profileDirectory = (instanceId: ProviderInstanceId) =>
    resolveAntigravityInstanceDirectories(host.paths.stateDir, instanceId).pipe(
      Effect.map((directories) => directories.profile),
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Antigravity profile directory could not be resolved.",
            cause,
          }),
      ),
    );

  const scan: AntigravityUsage["Service"]["scan"] = Effect.fn("AntigravityUsage.scan")(function* ({
    instances,
    unreadInstanceIds,
    windowStartMs,
  }) {
    // No allowed instance means nothing to count, not even T3's own Antigravity profiles.
    if (instances.length === 0) return [];
    const roots: Array<string> = [];
    for (const instance of instances) roots.push(...(yield* dataRoots(instance.environment)));
    for (const { instanceId } of instances) {
      roots.push(path.join(yield* profileDirectory(instanceId), "antigravity-acp"));
    }
    const unreadProfiles = new Set<string>();
    for (const instanceId of unreadInstanceIds)
      unreadProfiles.add(yield* profileDirectory(instanceId));
    // Profiles of removed or renamed instances keep their history on disk; keep counting it.
    const profilesDir = path.join(host.paths.stateDir, "providers", "antigravity");
    const profiles = yield* fileSystem
      .readDirectory(profilesDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const profile of profiles) {
      const profileDir = path.join(profilesDir, profile);
      if (!unreadProfiles.has(profileDir)) roots.push(path.join(profileDir, "antigravity-acp"));
    }
    const conversationDirs = new Set<string>();
    for (const root of roots) {
      const resolvedRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const nested = path.join(resolvedRoot, "conversations");
      const dir = (yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false))))
        ? nested
        : resolvedRoot;
      conversationDirs.add(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)));
    }
    const result = yield* readAntigravityUsage([...conversationDirs], windowStartMs, cache).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const scanned: ProviderUsageScan[] = [];
    for (const dir of conversationDirs) {
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const failed = result.errors.some(
        (error) => error === dir || error.startsWith(`${dir}${path.sep}`),
      );
      scanned.push({
        dir,
        files: !exists && !failed ? null : result.files.filter((file) => file.root === dir),
        status: failed ? "partial" : "ok",
        ...(failed ? { message: "Some Antigravity history could not be read." } : {}),
      });
    }
    return scanned;
  });

  return AntigravityUsage.of({ scan });
});

export const layer = Layer.effect(AntigravityUsage, make);

export const antigravityUsageReader: ProviderUsageReader<AntigravitySettings, AntigravityUsage> = {
  kind: "scan",
  provider: "antigravity",
  rateModel: antigravityRateModel,
  scan: ({ instances, settings, windowStartMs }) => {
    const read = new Set(instances.map(({ instanceId }) => instanceId));
    const unreadInstanceIds = Object.entries(settings.providerInstances)
      .filter(
        ([id, instance]) =>
          instance.driver === "antigravity" && !read.has(ProviderInstanceId.make(id)),
      )
      .map(([id]) => ProviderInstanceId.make(id));
    return AntigravityUsage.pipe(
      Effect.flatMap((usage) => usage.scan({ instances, unreadInstanceIds, windowStartMs })),
    );
  },
};

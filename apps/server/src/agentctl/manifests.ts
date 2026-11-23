import type { AgentctlSandboxManifest } from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { manifestVariant } from "./agentState.ts";

// Manifests live in the user's own repositories, so discovery walks each
// configured root a few levels deep and skips what is never a manifest home.
const MAX_DEPTH = 4;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "target", "dist", "build", "vendor"]);

const ManifestMetadata = fromYaml(
  Schema.Struct({
    metadata: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
  }),
);
const decodeManifestMetadata = Schema.decodeUnknownEffect(ManifestMetadata);

/** `agent.yaml` and `agent.<variant>.yaml`, in the order a picker should list them. */
export function manifestFileNames(entries: ReadonlyArray<string>): string[] {
  const names = entries.filter((name) => name === "agent.yaml" || manifestVariant(name) !== null);
  return names.toSorted((left, right) =>
    left === "agent.yaml" ? -1 : right === "agent.yaml" ? 1 : left.localeCompare(right),
  );
}

export const discoverManifests = Effect.fn("AgentctlSandboxes.discoverManifests")(function* (
  roots: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifests: AgentctlSandboxManifest[] = [];
  const visited = new Set<string>();

  const readAgentName = (manifestPath: string) =>
    fileSystem.readFileString(manifestPath).pipe(
      Effect.flatMap(decodeManifestMetadata),
      Effect.map((manifest) => manifest.metadata?.name ?? null),
      Effect.orElseSucceed(() => null),
    );

  // A manifest belongs to the innermost repository the walk passed through, so the picker can
  // group by it; a root that is not inside one stands in for it. Untraced: it runs once per
  // folder under every root, inside the discoverManifests span.
  const walk: (directory: string, repository: string, depth: number) => Effect.Effect<void> =
    Effect.fnUntraced(function* (directory: string, repository: string, depth: number) {
      if (visited.has(directory)) return;
      visited.add(directory);
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): string[] => []));
      const owner = entries.includes(".git") ? directory : repository;
      for (const fileName of manifestFileNames(entries)) {
        const manifestPath = path.join(directory, fileName);
        manifests.push({
          path: manifestPath,
          directory,
          repository: owner,
          variant: manifestVariant(fileName),
          agentName: yield* readAgentName(manifestPath),
        });
      }
      if (depth >= MAX_DEPTH) return;
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) continue;
        const child = path.join(directory, entry);
        const info = yield* fileSystem.stat(child).pipe(Effect.option);
        if (info._tag === "Some" && info.value.type === "Directory") {
          yield* walk(child, owner, depth + 1);
        }
      }
    });

  for (const root of roots) {
    const resolved = path.resolve(root);
    yield* walk(resolved, resolved, 0);
  }
  return manifests;
});

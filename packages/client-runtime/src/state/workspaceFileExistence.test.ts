import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FilesystemEntryMetadata,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { createWorkspaceFileExistenceAtom } from "./workspaceFileExistence.ts";

const environmentId = EnvironmentId.make("existence-environment");

function setup(input: {
  readonly metadata: Record<string, FilesystemEntryMetadata | null | "pending">;
  readonly search?: Record<string, ReadonlyArray<string>>;
}) {
  const searched: string[] = [];
  const statted: string[] = [];
  const metadata = Atom.family((path: string) => {
    statted.push(path);
    const value = input.metadata[path] ?? null;
    return Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null, never>>(
      value === "pending" ? AsyncResult.initial(true) : AsyncResult.success(value),
    );
  });
  const search = Atom.family((query: string) => {
    searched.push(query);
    return Atom.make<AsyncResult.AsyncResult<ProjectSearchEntriesResult, never>>(
      AsyncResult.success({
        entries: (input.search?.[query] ?? []).map((path) => ({ path, kind: "file" as const })),
        truncated: false,
      }),
    );
  });
  const existingFiles = createWorkspaceFileExistenceAtom(
    (target) => metadata(target.input.path),
    (target: { readonly input: ProjectSearchEntriesInput }) => search(target.input.query),
  );
  return { registry: AtomRegistry.make(), existingFiles, searched, statted };
}

describe("createWorkspaceFileExistenceAtom", () => {
  it("confirms only paths the environment knows exist", () => {
    const { registry, existingFiles, searched, statted } = setup({
      metadata: {
        "/repo/src/existing.ts": { kind: "file" },
        "/repo/avatars/u1.webp": null,
        "/repo/pending.ts": "pending",
        "/repo/Button.tsx": null,
        "/repo/Missing.tsx": null,
      },
      search: { "Button.tsx": ["src/ui/Button.tsx"], "Missing.tsx": ["src/MissingThing.tsx"] },
    });
    const found = registry.get(
      existingFiles({
        environmentId,
        cwd: "/repo",
        candidates: [
          { path: "/repo/src/existing.ts", lookup: null },
          { path: "/repo/avatars/u1.webp", lookup: null },
          { path: "/repo/pending.ts", lookup: "pending.ts" },
          { path: "/repo/Button.tsx", lookup: "Button.tsx" },
          { path: "/repo/Missing.tsx", lookup: "Missing.tsx" },
          { path: "\\\\server\\share\\a.ts", lookup: null },
        ],
      }),
    );

    expect([...found]).toEqual(["/repo/src/existing.ts", "/repo/Button.tsx"]);
    // Search runs only once the literal path is known to be missing.
    expect(searched).toEqual(["Button.tsx", "Missing.tsx"]);
    expect(statted).not.toContain("\\\\server\\share\\a.ts");
  });
});

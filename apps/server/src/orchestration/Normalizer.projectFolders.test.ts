import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeOS from "node:os";

import { CommandId, type ClientOrchestrationCommand, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-folders-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeDirs = Effect.fn("makeDirs")(function* (...names: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectory({ prefix: "t3-project-folders-" });
  const created: Record<string, string> = {};
  for (const name of names) {
    const absolute = path.join(root, name);
    yield* fileSystem.makeDirectory(absolute, { recursive: true }).pipe(Effect.orDie);
    created[name] = absolute;
  }
  return created;
});

const createCommand = (input: {
  workspaceRoot: string;
  additionalFolders?: ReadonlyArray<{ path: string; label?: string }>;
}): ClientOrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make("cmd-1"),
  projectId: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: input.workspaceRoot,
  ...(input.additionalFolders !== undefined ? { additionalFolders: input.additionalFolders } : {}),
  createdAt: "2026-01-01T00:00:00.000Z",
});

const failureMessage = (result: unknown) => JSON.stringify(result);

it.layer(TestLayer)("normalizeDispatchCommand project folders", (it) => {
  describe("project.create", () => {
    it.effect("normalizes and resolves every additional folder", () =>
      Effect.gen(function* () {
        const dirs = yield* makeDirs("app", "docs");
        const normalized = yield* normalizeDispatchCommand(
          createCommand({
            workspaceRoot: dirs.app!,
            additionalFolders: [{ path: `${dirs.docs!}/`, label: "Docs" }],
          }),
        );

        expect(normalized.type).toBe("project.create");
        expect(
          normalized.type === "project.create" ? normalized.additionalFolders : undefined,
        ).toEqual([{ path: dirs.docs!, label: "Docs" }]);
      }),
    );

    it.effect("leaves the field absent when the command omits it", () =>
      Effect.gen(function* () {
        const dirs = yield* makeDirs("app");
        const normalized = yield* normalizeDispatchCommand(
          createCommand({ workspaceRoot: dirs.app! }),
        );
        expect(
          normalized.type === "project.create" ? normalized.additionalFolders : "unset",
        ).toBeUndefined();
      }),
    );

    it.effect("rejects an additional folder equal to the primary", () =>
      Effect.gen(function* () {
        const dirs = yield* makeDirs("app");
        const result = yield* Effect.result(
          normalizeDispatchCommand(
            createCommand({
              workspaceRoot: dirs.app!,
              additionalFolders: [{ path: `${dirs.app!}/` }],
            }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(failureMessage(result)).toContain("already this project's primary folder");
      }),
    );

    it.effect("rejects duplicate additional folders", () =>
      Effect.gen(function* () {
        const dirs = yield* makeDirs("app", "docs");
        const result = yield* Effect.result(
          normalizeDispatchCommand(
            createCommand({
              workspaceRoot: dirs.app!,
              additionalFolders: [{ path: dirs.docs! }, { path: `${dirs.docs!}/` }],
            }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(failureMessage(result)).toContain("listed more than once");
      }),
    );

    it.effect("rejects a folder nested inside another folder", () =>
      Effect.gen(function* () {
        const dirs = yield* makeDirs("app", "app/packages/ui");
        const result = yield* Effect.result(
          normalizeDispatchCommand(
            createCommand({
              workspaceRoot: dirs.app!,
              additionalFolders: [{ path: dirs["app/packages/ui"]! }],
            }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(failureMessage(result)).toContain("must not contain one another");
      }),
    );

    it.effect("rejects the home directory and the filesystem root", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const dirs = yield* makeDirs("app");
        for (const folder of [NodeOS.homedir(), path.parse(process.cwd()).root]) {
          const result = yield* Effect.result(
            normalizeDispatchCommand(
              createCommand({
                workspaceRoot: dirs.app!,
                additionalFolders: [{ path: folder }],
              }),
            ),
          );
          expect(result._tag).toBe("Failure");
        }
      }),
    );
  });

  describe("project.meta.update", () => {
    it.effect("normalizes folders even when workspaceRoot is untouched", () =>
      Effect.gen(function* () {
        // Regression: the meta-update branch used to early-return unless
        // workspaceRoot was present, silently skipping folder normalization.
        const dirs = yield* makeDirs("docs");
        const normalized = yield* normalizeDispatchCommand({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-2"),
          projectId: ProjectId.make("project-1"),
          additionalFolders: [{ path: `${dirs.docs!}/` }],
        });

        expect(
          normalized.type === "project.meta.update" ? normalized.additionalFolders : undefined,
        ).toEqual([{ path: dirs.docs! }]);
      }),
    );
  });
});

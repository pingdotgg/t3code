import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ProjectAgentInventory } from "../Services/ProjectAgentInventory.ts";
import { ProjectAgentInventoryLive } from "./ProjectAgentInventory.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectAgentInventoryLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "forma-project-agent-inventory-",
  });
});

const writeTextFile = Effect.fn("ProjectAgentInventoryTest.writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

it.layer(TestLayer)("ProjectAgentInventoryLive", (it) => {
  describe("getInventory", () => {
    it.effect("discovers project-local skills and commands", () =>
      Effect.gen(function* () {
        const inventoryService = yield* ProjectAgentInventory;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          ".agents/skills/repo-review/SKILL.md",
          `---
description: Review repository changes
---

Inspect risky files first.`,
        );
        yield* writeTextFile(
          cwd,
          ".agents/commands/review-pr.md",
          `---
description: Review a pull request
argument-hint: [pr-number]
---

Review pull request $1 for regressions.`,
        );

        const inventory = yield* inventoryService.getInventory(cwd);

        expect(inventory.skills).toEqual([
          {
            name: "repo-review",
            path: ".agents/skills/repo-review/SKILL.md",
            scope: "project",
            enabled: true,
            source: "local-agents",
            description: "Review repository changes",
            shortDescription: "Review repository changes",
          },
        ]);
        expect(inventory.commands).toEqual([
          {
            name: "review-pr",
            path: ".agents/commands/review-pr.md",
            scope: "project",
            source: "local-agents",
            description: "Review a pull request",
            inputHint: "[pr-number]",
          },
        ]);
      }),
    );

    it.effect("ignores malformed command files without failing the inventory", () =>
      Effect.gen(function* () {
        const inventoryService = yield* ProjectAgentInventory;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".agents/commands/bad/command.json", "{ this is not valid json");
        yield* writeTextFile(
          cwd,
          ".agents/commands/good.md",
          `---
description: Good command
---

Do the good thing.`,
        );

        const inventory = yield* inventoryService.getInventory(cwd);

        expect(inventory.commands).toEqual([
          {
            name: "good",
            path: ".agents/commands/good.md",
            scope: "project",
            source: "local-agents",
            description: "Good command",
          },
        ]);
      }),
    );

    it.effect("returns an empty inventory when .agents is missing", () =>
      Effect.gen(function* () {
        const inventoryService = yield* ProjectAgentInventory;
        const cwd = yield* makeTempDir;

        const inventory = yield* inventoryService.getInventory(cwd);

        expect(inventory).toEqual({
          skills: [],
          commands: [],
        });
      }),
    );

    it.effect("invalidates cached inventory entries", () =>
      Effect.gen(function* () {
        const inventoryService = yield* ProjectAgentInventory;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          ".agents/commands/review.md",
          `---
description: Review once
---

Review once.`,
        );

        const firstInventory = yield* inventoryService.getInventory(cwd);
        expect(firstInventory.commands[0]?.description).toBe("Review once");

        yield* writeTextFile(
          cwd,
          ".agents/commands/review.md",
          `---
description: Review twice
---

Review twice.`,
        );
        yield* inventoryService.invalidate(cwd);

        const nextInventory = yield* inventoryService.getInventory(cwd);
        expect(nextInventory.commands[0]?.description).toBe("Review twice");
      }),
    );
  });
});

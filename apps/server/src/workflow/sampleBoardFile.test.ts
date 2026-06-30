import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { WorkflowDefinition } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { lintWorkflowDefinition } from "./workflowFile.ts";

const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));

it.layer(NodeServices.layer)("sample delivery board", (it) => {
  it.effect("decodes and lints for the default codex provider", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = path.join(process.cwd(), "../..");
      const raw = yield* fileSystem.readFileString(path.join(repoRoot, ".t3/boards/delivery.json"));
      const definition = yield* decodeWorkflowDefinitionJson(raw);
      const lintErrors = lintWorkflowDefinition(definition, {
        providerInstanceExists: (instanceId) => instanceId === "codex",
        instructionFileExists: () => true,
      });

      assert.equal(definition.name, "Standard delivery");
      assert.deepEqual(
        lintErrors.map((error) => error.code),
        [],
      );
    }),
  );
});

it.layer(NodeServices.layer)("github-flow example board", (it) => {
  it.effect("decodes and lints with no errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = path.join(process.cwd(), "../..");
      const raw = yield* fileSystem.readFileString(
        path.join(repoRoot, "docs/workflow-boards/github-flow-example.json"),
      );
      const definition = yield* decodeWorkflowDefinitionJson(raw);
      const lintErrors = lintWorkflowDefinition(definition, {
        providerInstanceExists: (instanceId) => instanceId === "codex",
        instructionFileExists: () => true,
      });

      assert.equal(definition.name, "GitHub flow");
      assert.deepEqual(
        lintErrors.map((error) => error.code),
        [],
      );
    }),
  );
});

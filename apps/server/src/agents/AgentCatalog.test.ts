import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as AgentCatalog from "./AgentCatalog.ts";

const write = Effect.fn("AgentCatalogTest.write")(function* (filePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

const withCatalog = <A, E, R>(
  workspaceRoot: string,
  baseDir: string,
  effect: Effect.Effect<A, E, AgentCatalog.AgentCatalog | R>,
) =>
  effect.pipe(
    Effect.provide(
      AgentCatalog.layer.pipe(
        Layer.provide(T3ProjectFileLoader.layer),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
      ),
    ),
  );

it.layer(NodeServices.layer)("AgentCatalog", (it) => {
  it.effect("discovers environment Markdown metadata and loads full documents lazily", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-catalog-" });
      const workspace = path.join(tempDir, "workspace");
      const stateDir = path.join(tempDir, "userdata");
      const profilePath = path.join(stateDir, "agents", "reviewer.md");
      const rulePath = path.join(stateDir, "rules", "typescript.md");

      yield* write(
        profilePath,
        [
          "---",
          "name: Reviewer",
          "description: Reviews changes.",
          "chatSelectable: false",
          "runtime:",
          "  mode: auto",
          "  interactionMode: default",
          "workspace:",
          "  mode: shared",
          "  access: read-only",
          "tools:",
          "  policy: inherit",
          "  allowed: []",
          "delegation:",
          "  policy: disabled",
          "  profiles: []",
          "budgets:",
          "  maxRuns: 1",
          "  maxConcurrency: 1",
          "  maxDepth: 0",
          "  maxWallTimeMinutes: 1",
          "hooks: []",
          "rules: []",
          "---",
          "",
          "Inspect the diff before replying.",
        ].join("\r\n"),
      );
      yield* write(
        rulePath,
        [
          "---",
          "name: TypeScript",
          "globs:",
          "  - '**/*.ts'",
          "alwaysApply: true",
          "priority: 10",
          "profiles:",
          "  - scope: environment",
          "    id: reviewer",
          "---",
          "",
          "Prefer inferred types.",
        ].join("\n"),
      );

      const listed = yield* withCatalog(
        workspace,
        tempDir,
        Effect.service(AgentCatalog.AgentCatalog).pipe(Effect.flatMap((catalog) => catalog.list())),
      );

      assert.deepEqual(
        listed.profiles.map((profile) => [profile.scope, profile.id]),
        [["environment", "reviewer"]],
      );
      assert.equal(listed.profiles[0]?.chatSelectable, false);
      assert.deepEqual(
        listed.rules.map((rule) => [rule.scope, rule.id]),
        [["environment", "typescript"]],
      );
      assert.equal(listed.rules[0]?.alwaysApply, true);
      assert.deepEqual(listed.rules[0]?.globs, ["**/*.ts"]);

      const profile = yield* withCatalog(
        workspace,
        tempDir,
        Effect.service(AgentCatalog.AgentCatalog).pipe(
          Effect.flatMap((catalog) =>
            catalog.getProfile({
              ref: { scope: listed.profiles[0]!.scope, id: listed.profiles[0]!.id },
            }),
          ),
        ),
      );
      assert.equal(profile.instructions, "Inspect the diff before replying.");
      assert.equal(profile.chatSelectable, false);

      const firstRevision = listed.profiles[0]?.revision;
      yield* write(
        profilePath,
        [
          "---",
          "name: Reviewer",
          "description: Reviews changes.",
          "chatSelectable: false",
          "runtime:",
          "  mode: auto",
          "  interactionMode: default",
          "workspace:",
          "  mode: shared",
          "  access: read-only",
          "tools:",
          "  policy: inherit",
          "  allowed: []",
          "delegation:",
          "  policy: disabled",
          "  profiles: []",
          "budgets:",
          "  maxRuns: 1",
          "  maxConcurrency: 1",
          "  maxDepth: 0",
          "  maxWallTimeMinutes: 1",
          "hooks: []",
          "rules: []",
          "---",
          "",
          "Inspect the diff before replying.",
        ].join("\n"),
      );
      const revised = yield* withCatalog(
        workspace,
        tempDir,
        Effect.service(AgentCatalog.AgentCatalog).pipe(Effect.flatMap((catalog) => catalog.list())),
      );
      assert.equal(revised.profiles[0]?.revision, firstRevision);
    }),
  );

  it.effect(
    "uses only explicit project references, rejects escapes, and reports duplicate scoped ids",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-catalog-" });
        const workspace = path.join(tempDir, "workspace");
        const outside = path.join(tempDir, "outside.md");
        const first = path.join(workspace, ".t3", "agents", "first.md");
        const second = path.join(workspace, ".t3", "agents", "second.md");
        const unreferenced = path.join(workspace, ".t3", "agents", "unreferenced.md");

        const profileDocument = (name: string, instructions: string) =>
          [
            "---",
            `name: ${name}`,
            "runtime:",
            "  mode: auto",
            "  interactionMode: default",
            "workspace:",
            "  mode: shared",
            "  access: read-only",
            "tools:",
            "  policy: inherit",
            "  allowed: []",
            "delegation:",
            "  policy: disabled",
            "  profiles: []",
            "budgets:",
            "  maxRuns: 1",
            "  maxConcurrency: 1",
            "  maxDepth: 0",
            "  maxWallTimeMinutes: 1",
            "hooks: []",
            "rules: []",
            "---",
            "",
            instructions,
          ].join("\n");
        yield* write(first, profileDocument("First", "First instructions."));
        yield* write(second, profileDocument("Second", "Second instructions."));
        yield* write(unreferenced, "---\nname: Hidden\n---\n\nNever discover this.\n");
        yield* write(outside, "---\nname: Outside\n---\n\nOutside workspace.\n");
        yield* write(
          path.join(workspace, "t3.json"),
          [
            "{",
            '  "agents": [',
            '    { "id": "review", "path": ".t3/agents/first.md" },',
            '    { "id": "review", "path": ".t3/agents/second.md" },',
            '    { "id": "escape", "path": "../outside.md" }',
            "  ]",
            "}",
          ].join("\n"),
        );

        const listed = yield* withCatalog(
          workspace,
          tempDir,
          Effect.service(AgentCatalog.AgentCatalog).pipe(
            Effect.flatMap((catalog) => catalog.list({ workspaceRoot: workspace })),
          ),
        );

        assert.deepEqual(
          listed.profiles.map((profile) => [profile.scope, profile.id]),
          [["project", "review"]],
        );
        assert.isTrue(listed.diagnostics.some((entry) => entry.code === "duplicate"));
        assert.isTrue(listed.diagnostics.some((entry) => entry.code === "outside-root"));
        assert.isFalse(listed.profiles.some((profile) => profile.name === "Hidden"));
      }),
  );

  it.effect(
    "keeps optional directories quiet but reports unreadable catalog roots and normalizes .MD ids",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-catalog-" });
        const workspace = path.join(tempDir, "workspace");
        const stateDir = path.join(tempDir, "userdata");

        // A file where the optional directory belongs is an operational failure, not an empty catalog.
        yield* write(path.join(stateDir, "agents"), "not a directory");
        const unreadable = yield* withCatalog(
          workspace,
          tempDir,
          Effect.service(AgentCatalog.AgentCatalog).pipe(
            Effect.flatMap((catalog) => catalog.list()),
          ),
        );
        assert.isTrue(
          unreadable.diagnostics.some(
            (entry) => entry.kind === "profile" && entry.code === "read-failed",
          ),
        );
        assert.isFalse(unreadable.diagnostics.some((entry) => entry.kind === "rule"));

        yield* fileSystem.remove(path.join(stateDir, "agents"));
        yield* write(
          path.join(stateDir, "agents", "reviewer.MD"),
          [
            "---",
            "name: Reviewer",
            "runtime: { mode: auto, interactionMode: default }",
            "workspace: { mode: shared, access: read-only }",
            "tools: { policy: inherit, allowed: [] }",
            "delegation: { policy: disabled, profiles: [] }",
            "budgets: { maxRuns: 1, maxConcurrency: 1, maxDepth: 0, maxWallTimeMinutes: 1 }",
            "hooks: []",
            "rules: []",
            "---",
            "",
            "Review.",
          ].join("\n"),
        );
        const catalog = yield* withCatalog(
          workspace,
          tempDir,
          Effect.service(AgentCatalog.AgentCatalog).pipe(
            Effect.flatMap((service) => service.list()),
          ),
        );
        assert.deepEqual(
          catalog.profiles.map((profile) => profile.id),
          ["reviewer"],
        );
      }),
  );
});

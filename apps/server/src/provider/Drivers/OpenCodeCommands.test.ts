import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import {
  mergeOpenCodeCommandCwds,
  parseOpenCodeDebugConfigCommands,
  parseOpenCodeSdkCommands,
  queryOpenCodeCommandCatalog,
  queryOpenCodeSdkCommandCatalog,
} from "./OpenCodeCommands.ts";

it.layer(NodeServices.layer)("parseOpenCodeDebugConfigCommands", (it) => {
  it("parses the resolved config command map", () => {
    const commands = parseOpenCodeDebugConfigCommands({
      $schema: "https://opencode.ai/config.json",
      command: {
        "deploy-check": {
          description: "Run the project deploy checklist",
          agent: "build",
          template: "Deploy checklist for $ARGUMENTS",
        },
        "no-description": { template: "Do a thing" },
        "  ": { description: "blank names are dropped" },
      },
      mcp: { ignored: true },
    });

    assert.deepEqual(commands, [
      { name: "deploy-check", description: "Run the project deploy checklist" },
      { name: "no-description" },
    ]);
  });

  it("returns an empty list when the report has no command map or is not an object", () => {
    assert.deepEqual(parseOpenCodeDebugConfigCommands({ agent: {} }), []);
    assert.deepEqual(parseOpenCodeDebugConfigCommands("not json"), []);
    assert.deepEqual(parseOpenCodeDebugConfigCommands(undefined), []);
  });
});

it.layer(NodeServices.layer)("parseOpenCodeSdkCommands", (it) => {
  it("maps name and description and drops blank names", () => {
    const commands = parseOpenCodeSdkCommands([
      {
        name: "init",
        description: "guided AGENTS.md setup",
        source: "command",
        template: "template",
        hints: ["$ARGUMENTS"],
      },
      {
        name: "deploy",
        description: "Project deploy skill",
        source: "skill",
        template: "template",
        hints: [],
      },
      { name: "  ", template: "template", hints: [] },
    ]);

    assert.deepEqual(commands, [
      { name: "init", description: "guided AGENTS.md setup" },
      { name: "deploy", description: "Project deploy skill" },
    ]);
  });
});

it.layer(NodeServices.layer)("mergeOpenCodeCommandCwds", (it) => {
  it("promotes commands seen in every workspace to global and tags the rest", () => {
    const merged = mergeOpenCodeCommandCwds([
      {
        cwd: "/workspace/a",
        commands: [{ name: "global-cmd" }, { name: "a-only", description: "A command" }],
      },
      {
        cwd: "/workspace/b",
        commands: [{ name: "global-cmd" }, { name: "b-only" }],
      },
    ]);

    assert.deepEqual(
      merged.map((command) => [command.name, command.sourceCwd, command.description]),
      [
        ["a-only", "/workspace/a", "A command"],
        ["b-only", "/workspace/b", undefined],
        ["global-cmd", undefined, undefined],
        ["init", undefined, "guided AGENTS.md setup"],
        ["review", undefined, "review changes [commit|branch|pr], defaults to uncommitted"],
      ],
    );
  });

  it("keeps harness descriptions for built-ins the harness also reports", () => {
    const merged = mergeOpenCodeCommandCwds([
      {
        cwd: "/workspace/a",
        commands: [{ name: "init", description: "harness init" }],
      },
    ]);

    const init = merged.find((command) => command.name === "init");
    assert.equal(init?.description, "harness init");
    assert.equal(init?.sourceCwd, undefined);
  });

  it("keeps a project override next to the global built-in", () => {
    const merged = mergeOpenCodeCommandCwds([
      {
        cwd: "/workspace/a",
        commands: [{ name: "review", description: "repo review" }],
      },
      { cwd: "/workspace/b", commands: [] },
    ]);

    const reviews = merged.filter((command) => command.name === "review");
    assert.deepEqual(
      reviews.map((command) => [command.sourceCwd, command.description]),
      [
        [undefined, "review changes [commit|branch|pr], defaults to uncommitted"],
        ["/workspace/a", "repo review"],
      ],
    );
  });

  it("returns built-ins when no workspace query succeeded", () => {
    const merged = mergeOpenCodeCommandCwds([]);
    assert.deepEqual(
      merged.map((command) => command.name),
      ["init", "review"],
    );
  });
});

const testInfraLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testInfraLayer)("queryOpenCodeCommandCatalog", (it) => {
  const writeFakeOpenCode = Effect.fn(function* (dir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binaryPath = path.join(dir, "opencode");
    yield* fs.writeFileString(
      binaryPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "debug" ] && [ "$2" = "config" ]; then',
        '  cat "$PWD/debug-config.json"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    yield* fs.chmod(binaryPath, 0o755);
    return binaryPath;
  });

  it.effect("queries debug config per workspace and scopes project commands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-opencode-commands-",
        });
        const workspaceA = path.join(dir, "a");
        const workspaceB = path.join(dir, "b");
        yield* fs.makeDirectory(workspaceA, { recursive: true });
        yield* fs.makeDirectory(workspaceB, { recursive: true });
        yield* fs.writeFileString(
          path.join(workspaceA, "debug-config.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed harness-owned fixture document.
          JSON.stringify({
            command: {
              "deploy-check": { description: "A deploy", template: "..." },
              shared: { description: "Everywhere", template: "..." },
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(workspaceB, "debug-config.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed harness-owned fixture document.
          JSON.stringify({
            command: {
              "b-tool": { description: "B tool", template: "..." },
              shared: { description: "Everywhere", template: "..." },
            },
          }),
        );
        const binaryPath = yield* writeFakeOpenCode(dir);

        const commands = yield* queryOpenCodeCommandCatalog({
          binaryPath,
          cwd: [workspaceA, workspaceB],
        });

        const byName = (name: string) => commands.find((command) => command.name === name);
        assert.equal(byName("deploy-check")?.sourceCwd, workspaceA);
        assert.equal(byName("b-tool")?.sourceCwd, workspaceB);
        assert.equal(byName("shared")?.sourceCwd, undefined);
        assert.ok(byName("init"));
        assert.ok(byName("review"));
      }),
    ),
  );

  it.effect("degrades to built-ins when the binary cannot serve debug config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-opencode-commands-bad-",
        });
        const binaryPath = path.join(dir, "opencode");
        yield* fs.writeFileString(binaryPath, ["#!/bin/sh", "exit 1", ""].join("\n"));
        yield* fs.chmod(binaryPath, 0o755);

        const commands = yield* queryOpenCodeCommandCatalog({
          binaryPath,
          cwd: dir,
        });
        assert.deepEqual(
          commands.map((command) => command.name),
          ["init", "review"],
        );
      }),
    ),
  );
});

it.layer(NodeServices.layer)("queryOpenCodeSdkCommandCatalog", (it) => {
  it.effect("merges command.list responses per directory with project scoping", () =>
    Effect.gen(function* () {
      const client = {
        command: {
          list: async ({ directory }: { directory?: string }) => ({
            data:
              directory === "/workspace/a"
                ? [
                    {
                      name: "init",
                      description: "guided AGENTS.md setup",
                      hints: [],
                    },
                    {
                      name: "deploy-check",
                      description: "A deploy",
                      hints: ["$ARGUMENTS"],
                    },
                  ]
                : [
                    {
                      name: "init",
                      description: "guided AGENTS.md setup",
                      hints: [],
                    },
                  ],
          }),
        },
      } as unknown as OpencodeClient;

      const commands = yield* queryOpenCodeSdkCommandCatalog({
        client,
        cwd: ["/workspace/a", "/workspace/b"],
      });

      const byName = (name: string) => commands.find((command) => command.name === name);
      assert.equal(byName("deploy-check")?.sourceCwd, "/workspace/a");
      assert.equal(byName("init")?.sourceCwd, undefined);
      assert.equal(byName("init")?.description, "guided AGENTS.md setup");
      assert.ok(byName("review"));
    }),
  );

  it.effect("keeps built-ins when every command.list call fails", () =>
    Effect.gen(function* () {
      const client = {
        command: {
          list: async () => {
            throw new Error("connection refused");
          },
        },
      } as unknown as OpencodeClient;

      const commands = yield* queryOpenCodeSdkCommandCatalog({
        client,
        cwd: ["/workspace/a"],
      });
      assert.deepEqual(
        commands.map((command) => command.name),
        ["init", "review"],
      );
    }),
  );
});

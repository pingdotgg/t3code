import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  GROK_WORKFLOW_CONTROL_COMMANDS,
  grokWorkflowHomeDirFromEnvironment,
  parseGrokWorkflowScriptMeta,
  readGrokWorkflowSlashCommands,
} from "./GrokWorkflowCommands.ts";

describe("grokWorkflowHomeDirFromEnvironment", () => {
  it("prefers HOME over USERPROFILE", () => {
    expect(
      grokWorkflowHomeDirFromEnvironment({
        HOME: "/home/ada",
        USERPROFILE: "C:\\Users\\ada",
      }),
    ).toBe("/home/ada");
  });

  it("uses USERPROFILE when HOME is unset", () => {
    expect(grokWorkflowHomeDirFromEnvironment({ USERPROFILE: "C:\\Users\\ada" })).toBe(
      "C:\\Users\\ada",
    );
  });

  it("ignores blank HOME so Windows profiles still resolve", () => {
    expect(
      grokWorkflowHomeDirFromEnvironment({
        HOME: "  ",
        USERPROFILE: "C:\\Users\\ada",
      }),
    ).toBe("C:\\Users\\ada");
  });
});

describe("parseGrokWorkflowScriptMeta", () => {
  it("reads name and description from the Rhai meta block", () => {
    const meta = parseGrokWorkflowScriptMeta(
      `let meta = #{
  name: "review-changes",
  description: "Review the latest diff"
};
agent("review", "look at the diff")
`,
    );
    expect(meta).toEqual({
      name: "review-changes",
      description: "Review the latest diff",
    });
  });

  it("falls back to the filename when meta has no name", () => {
    expect(parseGrokWorkflowScriptMeta('agent("hello", "there")', "t1")).toEqual({
      name: "t1",
      description: undefined,
    });
  });

  it("rejects path-like names", () => {
    expect(
      parseGrokWorkflowScriptMeta(`let meta = #{ name: "../escape" };`, "safe"),
    ).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("readGrokWorkflowSlashCommands", (it) => {
  it.effect("includes pause/resume/stop and project scripts override user scripts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-wf-" });
        const home = path.join(root, "home");
        const project = path.join(root, "project");
        yield* fs.makeDirectory(path.join(home, ".grok", "workflows"), { recursive: true });
        yield* fs.makeDirectory(path.join(project, ".grok", "workflows"), { recursive: true });
        yield* fs.writeFileString(
          path.join(home, ".grok", "workflows", "review-changes.rhai"),
          `let meta = #{ name: "review-changes", description: "user copy" };\n`,
        );
        yield* fs.writeFileString(
          path.join(project, ".grok", "workflows", "review-changes.rhai"),
          `let meta = #{ name: "review-changes", description: "project copy" };\n`,
        );
        yield* fs.writeFileString(
          path.join(project, ".grok", "workflows", "nowah-web-e2e.rhai"),
          `let meta = #{ name: "nowah-web-e2e", description: "Write locked Playwright specs" };\n`,
        );

        const commands = yield* readGrokWorkflowSlashCommands({
          homeDir: home,
          projectRoot: project,
        });
        expect(commands.slice(0, 3)).toEqual([...GROK_WORKFLOW_CONTROL_COMMANDS]);
        expect(commands).toContainEqual({
          name: "workflow review-changes",
          description: "project copy",
        });
        expect(commands).toContainEqual({
          name: "workflow nowah-web-e2e",
          description: "Write locked Playwright specs",
        });
      }),
    ),
  );

  it.effect("reads only the capped prefix of an oversized workflow script", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-wf-cap-" });
        yield* fs.makeDirectory(path.join(root, ".grok", "workflows"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, ".grok", "workflows", "huge.rhai"),
          `let meta = #{ name: "huge", description: "from prefix" };\n` + "x".repeat(80 * 1024),
        );
        const commands = yield* readGrokWorkflowSlashCommands({ homeDir: root });
        expect(commands).toContainEqual({
          name: "workflow huge",
          description: "from prefix",
        });
      }),
    ),
  );

  it.effect("does not parse workflow meta past the 64 KiB prefix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-wf-cap-tail-" });
        yield* fs.makeDirectory(path.join(root, ".grok", "workflows"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, ".grok", "workflows", "late.rhai"),
          "x".repeat(80 * 1024) + `\nlet meta = #{ name: "late", description: "after prefix" };\n`,
        );
        const commands = yield* readGrokWorkflowSlashCommands({ homeDir: root });
        expect(commands.find((command) => command.name === "workflow late")?.description).not.toBe(
          "after prefix",
        );
      }),
    ),
  );
});

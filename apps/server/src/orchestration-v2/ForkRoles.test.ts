import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import { ProviderInstanceId } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as CodexAdapterV2 from "./Adapters/CodexAdapterV2.ts";
import * as ForkRoles from "./ForkRoles.ts";

const withRoles = (forkRolesDirectory: string, warnings: Array<string> = []) =>
  Effect.provide(
    Layer.mergeAll(
      ForkRoles.layer.pipe(Layer.provide(ServerSettings.layerTest({ forkRolesDirectory }))),
      Logger.layer([Logger.make(({ message }) => void warnings.push(JSON.stringify(message)))], {
        mergeWithExisting: false,
      }),
    ),
  );

const rolesDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-roles-" });
  const write = (name: string, contents: string) =>
    fs.writeFileString(path.join(dir, name), contents);
  yield* write(
    "needs-you.md",
    "---\nname: Needs you\nicon: inbox\ncolor: amber\n---\nTriage the needs-you queue.\n",
  );
  yield* write("plain.md", "Just a brief.");
  yield* write("broken.md", "---\nname: [unclosed\n---\nBody after bad frontmatter.");
  yield* write("empty.md", "---\nname: Empty\n---\n");
  yield* write("notes.txt", "not a role");
  yield* write("bad id.md", "stem is not a role id");
  return { dir: yield* fs.realPath(dir), path };
});

it.describe("parseRoleFile", () => {
  it("reads frontmatter fields and the body after it", () => {
    assert.deepEqual(ForkRoles.parseRoleFile("---\nname: A\nicon: bot\n---\n\nBody\n"), {
      name: "A",
      icon: "bot",
      brief: "Body",
    });
  });

  it("ignores malformed frontmatter but keeps the body", () => {
    assert.deepEqual(ForkRoles.parseRoleFile("---\nname: [x\n---\nBody"), { brief: "Body" });
  });

  it("treats a file without frontmatter as all body", () => {
    assert.deepEqual(ForkRoles.parseRoleFile("Body only"), { brief: "Body only" });
  });
});

it.layer(NodeServices.layer)("ForkRoles", (it) => {
  it.effect("lists only .md files whose stem is a role id, named from frontmatter or stem", () =>
    Effect.gen(function* () {
      const { dir, path } = yield* rolesDirectory;
      const result = yield* Effect.flatMap(ForkRoles.ForkRoles, (roles) => roles.list).pipe(
        withRoles(dir),
      );
      assert.equal(result.directory, dir);
      assert.deepEqual(result.roles, [
        { id: "broken", name: "broken", path: path.join(dir, "broken.md") },
        { id: "empty", name: "Empty", path: path.join(dir, "empty.md") },
        {
          id: "needs-you",
          name: "Needs you",
          icon: "inbox",
          color: "amber",
          path: path.join(dir, "needs-you.md"),
        },
        { id: "plain", name: "plain", path: path.join(dir, "plain.md") },
      ]);
    }),
  );

  it.effect("reads a brief fresh from disk on every call", () =>
    Effect.gen(function* () {
      const { dir, path } = yield* rolesDirectory;
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        const roles = yield* ForkRoles.ForkRoles;
        assert.equal(yield* roles.readBrief("needs-you"), "Triage the needs-you queue.");
        yield* fs.writeFileString(path.join(dir, "needs-you.md"), "Edited brief.");
        assert.equal(yield* roles.readBrief("needs-you"), "Edited brief.");
        assert.equal(yield* roles.readBrief("broken"), "Body after bad frontmatter.");
        assert.isUndefined(yield* roles.readBrief("empty"));
      }).pipe(withRoles(dir));
    }),
  );

  it.effect("returns no brief and warns with the role and path when the file is missing", () =>
    Effect.gen(function* () {
      const { dir, path } = yield* rolesDirectory;
      const warnings: Array<string> = [];
      const brief = yield* Effect.flatMap(ForkRoles.ForkRoles, (roles) =>
        roles.readBrief("gone"),
      ).pipe(withRoles(dir, warnings));
      assert.isUndefined(brief);
      assert.isTrue(
        warnings.some(
          (warning) =>
            warning.includes("role file missing or unreadable") &&
            warning.includes('"roleId":"gone"') &&
            warning.includes(JSON.stringify(path.join(dir, "gone.md"))),
        ),
        warnings.join("\n"),
      );
    }),
  );

  it.effect("rejects an id that would leave the directory", () =>
    Effect.gen(function* () {
      const { dir } = yield* rolesDirectory;
      const brief = yield* Effect.flatMap(ForkRoles.ForkRoles, (roles) =>
        roles.readBrief("../needs-you"),
      ).pipe(withRoles(dir));
      assert.isUndefined(brief);
    }),
  );

  it.effect("is off with an empty setting or an unreadable directory", () =>
    Effect.gen(function* () {
      const { dir, path } = yield* rolesDirectory;
      for (const directory of ["", path.join(dir, "missing")]) {
        yield* Effect.gen(function* () {
          const roles = yield* ForkRoles.ForkRoles;
          assert.deepEqual(yield* roles.list, { directory: null, roles: [] });
        }).pipe(withRoles(directory));
      }
      assert.isUndefined(
        yield* Effect.flatMap(ForkRoles.ForkRoles, (roles) => roles.readBrief("needs-you")).pipe(
          withRoles(""),
        ),
      );
    }),
  );
});

it.describe("Codex role context", () => {
  const build = (roleInstructions: string | undefined, hasT3Mcp: boolean) =>
    CodexAdapterV2.buildCodexTurnStartParams({
      nativeThreadId: "native-role",
      codexInput: [{ type: "text", text: "test" }],
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/work/app" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      hasT3Mcp,
      roleInstructions,
    });

  it.effect("sends the role block as its own entry, with or without T3 Code's MCP tools", () =>
    Effect.gen(function* () {
      const role = '<role id="needs-you">\nTriage the queue.\n</role>';
      const withoutMcp = yield* build(role, false);
      assert.deepEqual(withoutMcp.additionalContext, {
        t3_code_role_01: { kind: "application", value: role },
      });
      assert.deepEqual((yield* build(role, true)).additionalContext?.t3_code_role_01, {
        kind: "application",
        value: role,
      });
      assert.isUndefined((yield* build(undefined, false)).additionalContext);
    }),
  );

  it.effect("splits a long brief at line breaks into numbered entries under the cap", () =>
    Effect.gen(function* () {
      const role = Array.from(
        { length: 300 },
        (_, index) => `line ${index} ${"é".repeat(20)}`,
      ).join("\n");
      const context = (yield* build(role, false)).additionalContext ?? {};
      const keys = Object.keys(context);
      assert.isAbove(keys.length, 1);
      assert.deepEqual(
        keys,
        keys.map((_, index) => `t3_code_role_${String(index + 1).padStart(2, "0")}`),
      );
      const values = keys.map((key) => context[key]!.value);
      for (const value of values) assert.isAtMost(Buffer.byteLength(value), 4_000);
      assert.equal(values.join("\n"), role);
    }),
  );
});

it.layer(NodeServices.layer)("forkRoleInstructions", (it) => {
  it.effect("wraps the brief in a role block, and gives none for a missing file", () =>
    Effect.gen(function* () {
      const { dir } = yield* rolesDirectory;
      yield* Effect.gen(function* () {
        const roles = yield* ForkRoles.ForkRoles;
        assert.equal(
          yield* ForkRoles.forkRoleInstructions(roles, "needs-you"),
          '<role id="needs-you">\nThis thread holds a standing role. Its brief, from needs-you.md:\n\nTriage the needs-you queue.\n</role>',
        );
        assert.isUndefined(yield* ForkRoles.forkRoleInstructions(roles, "gone"));
        assert.isUndefined(yield* ForkRoles.forkRoleInstructions(roles, null));
      }).pipe(withRoles(dir));
    }),
  );
});

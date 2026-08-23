import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveSkillWorkspaceCwds } from "./SkillWorkspaceCwds.ts";

it.layer(NodeServices.layer)("resolveSkillWorkspaceCwds", (it) => {
  it.effect("resolves project roots and worktrees, deduplicated and absolute", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwds = resolveSkillWorkspaceCwds({
        path,
        serverCwd: "/server",
        activeWorkspaceCwds: ["/tmp/project-a", " /tmp/project-b ", "/tmp/project-a/"],
      });
      assert.deepEqual(cwds, ["/tmp/project-a", "/tmp/project-b"]);
    }),
  );

  it.effect("falls back to the server cwd only when no workspace is active", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.deepEqual(
        resolveSkillWorkspaceCwds({ path, serverCwd: "/server", activeWorkspaceCwds: [] }),
        ["/server"],
      );
      assert.deepEqual(
        resolveSkillWorkspaceCwds({
          path,
          serverCwd: "/server",
          activeWorkspaceCwds: ["/tmp/project-a"],
        }),
        ["/tmp/project-a"],
      );
    }),
  );

  it.effect("drops blank workspace entries and falls back when all are blank", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.deepEqual(
        resolveSkillWorkspaceCwds({
          path,
          serverCwd: " /server ",
          activeWorkspaceCwds: ["   ", ""],
        }),
        ["/server"],
      );
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as MemoryVaultService from "./MemoryVaultService.ts";

const layer = MemoryVaultService.layer.pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "continuum-vaults-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("MemoryVaultService", (it) => {
  it.effect("keeps a thread's vault separate from its project and enforces access", () =>
    Effect.gen(function* () {
      const vaults = yield* MemoryVaultService.MemoryVaultService;
      const { vaultId } = yield* vaults.manage({ action: "create", name: "Continuum IDE" });
      assert.strictEqual(vaultId, "continuum-ide");

      // Two unrelated threads share the vault; neither inherits the other's choice.
      const chosen = yield* vaults.select({ threadId: "thread-a", vaultId: "continuum-ide" });
      assert.deepStrictEqual(chosen.selection, {
        vaultId: "continuum-ide",
        access: "read-write",
        inherited: false,
      });
      const other = yield* vaults.overview("thread-b");
      assert.deepStrictEqual(other.selection, {
        vaultId: null,
        access: "read-write",
        inherited: true,
      });

      const written = yield* vaults.agentUpdate({
        threadId: "thread-a",
        path: "DECISIONS.md",
        mode: "replace_section",
        section: "Authentication",
        content: "Use magic links. Never store API_KEY=supersecretvalue123 here.",
      });
      assert.strictEqual(written.redacted, 1);
      const decisions = yield* vaults.readFile("continuum-ide", "DECISIONS.md");
      assert.include(decisions, "## Authentication\n\nUse magic links.");
      assert.notInclude(decisions, "supersecretvalue123");

      // The update reaches a different thread's next turn through retrieval.
      yield* vaults.select({ threadId: "thread-b", vaultId: "continuum-ide", access: "read-only" });
      const context = yield* vaults.contextForTurn({
        threadId: "thread-b",
        userText: "How does authentication work?",
        projectName: "Unrelated Website",
      });
      assert.include(context, "Use magic links.");
      assert.include(context, "read-only");

      const refused = yield* Effect.exit(
        vaults.agentUpdate({
          threadId: "thread-b",
          path: "TASKS.md",
          mode: "append",
          content: "x",
        }),
      );
      assert.isTrue(Exit.isFailure(refused));
    }),
  );

  it.effect("creates a vault per project when asked and persists choices", () =>
    Effect.gen(function* () {
      const vaults = yield* MemoryVaultService.MemoryVaultService;
      yield* vaults.updateSettings({ autoCreate: true });
      const context = yield* vaults.contextForTurn({
        threadId: "thread-c",
        userText: "Start the project",
        projectName: "My Web Application",
      });
      assert.include(context, 'vault "My Web Application"');
      const overview = yield* vaults.overview("thread-c");
      assert.strictEqual(overview.selection?.vaultId, "my-web-application");
      // Stored in Continuum's data directory, not in any project.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.isTrue(
        yield* fs.exists(path.join(overview.storageRoot, "my-web-application", "PROJECT.md")),
      );
      yield* vaults.updateSettings({ autoCreate: false });
    }),
  );

  it.effect("exports, imports, renames, and deletes vaults", () =>
    Effect.gen(function* () {
      const vaults = yield* MemoryVaultService.MemoryVaultService;
      const fs = yield* FileSystem.FileSystem;
      const target = yield* fs.makeTempDirectoryScoped({ prefix: "continuum-vault-export-" });
      const { vaultId } = yield* vaults.manage({ action: "create", name: "Exported" });
      yield* vaults.writeFile(vaultId!, "notes/extra.md", "# Extra\n\nKept.\n");
      yield* vaults.manage({ action: "export", vaultId: vaultId!, directory: target });
      const imported = yield* vaults.manage({
        action: "import",
        directory: target,
        name: "Imported",
      });
      assert.include(yield* vaults.readFile(imported.vaultId!, "notes/extra.md"), "Kept.");
      yield* vaults.manage({ action: "rename", vaultId: imported.vaultId!, name: "Renamed" });
      yield* vaults.manage({ action: "delete", vaultId: vaultId! });
      const names = (yield* vaults.overview()).vaults.map((vault) => vault.name);
      assert.include(names, "Renamed");
      assert.notInclude(names, "Exported");
    }).pipe(Effect.scoped),
  );
});

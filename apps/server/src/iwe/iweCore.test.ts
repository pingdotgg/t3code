// @effect-diagnostics nodeBuiltinImport:off - Drives the real iwe and iwes binaries against a temporary workspace.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { IweCore, parseIweConfig } from "./iweCore.ts";
import { applyTextEdits } from "./iweLanguageServer.ts";

const binDir = process.env.CONTINUUM_TEST_IWE_BIN ?? null;
// Runs where IWE is installed (NixOS dev machines, or CONTINUUM_TEST_IWE_BIN); the paths below are Linux ones.
const hasIwe =
  NodeOS.type() === "Linux" &&
  (binDir !== null || NodeChildProcess.spawnSync("iwe", ["--version"]).status === 0);

async function core() {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-iwe-base-"));
  const env = {
    ...process.env,
    PATH: binDir
      ? `${binDir}${NodePath.delimiter}${process.env.PATH ?? ""}`
      : (process.env.PATH ?? ""),
  };
  return IweCore.start({ baseDir, stateDir: baseDir, platform: "linux", arch: "x64", env });
}

describe("IWE helpers", () => {
  it("reads workspace settings without rewriting them", () => {
    expect(
      parseIweConfig(
        '[workspace]\npath = "notes"\n[markdown]\nrefs_extension = ".md"\n[completion]\nlink_format = "wiki"\n',
      ),
    ).toEqual({
      workspacePath: "notes",
      linkFormat: "wiki",
      refsExtension: ".md",
    });
  });

  it("applies LSP edits, including whole-document replacements", () => {
    expect(
      applyTextEdits("one\ntwo\n", [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          newText: "2",
        },
      ]),
    ).toBe("one\n2\n");
    expect(
      applyTextEdits("old", [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 4294967295, character: 0 } },
          newText: "new",
        },
      ]),
    ).toBe("new");
  });
});

describe.skipIf(!hasIwe)("IWE workspaces with the real iwe and iwes", () => {
  it("creates a workspace, links notes, searches, renames through iwes and iwe, and attaches context", async () => {
    const iwe = await core();
    try {
      const status = await iwe.status();
      expect(status.cli?.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(status.languageServer).not.toBeNull();

      const root = NodePath.join(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "continuum-iwe-")),
        "garden",
      );
      const created = await iwe.prepare(root, "new");
      expect(created).toMatchObject({ root, documentCount: 1 });
      await expect(iwe.prepare(NodePath.dirname(root), "open")).rejects.toThrow(
        "not an IWE workspace",
      );
      expect(
        (
          await iwe
            .prepare(NodePath.join(root, "sub-folder-does-not-matter"), "open")
            .catch(() => null)
        )?.root ?? root,
      ).toBe(root);

      const reading = await iwe.create(root, {
        title: "Reading list",
        content: "- Knowledge graphs",
      });
      expect(reading.key).toBe("reading-list");
      await iwe.create(root, {
        key: "projects/continuum",
        content: "# Continuum\n\nSee [Reading list](../reading-list.md) for background.\n",
      });
      const withBacklink = await iwe.note(root, "reading-list");
      expect(withBacklink.referencedBy).toEqual([
        { key: "projects/continuum", title: "Continuum" },
      ]);
      expect((await iwe.search(root, "contin", "fuzzy", 10)).map((note) => note.key)).toContain(
        "projects/continuum",
      );
      expect((await iwe.search(root, "background", "lexical", 10)).map((note) => note.key)).toEqual(
        ["projects/continuum"],
      );

      const draft =
        "# Continuum\n\nSee [Reading list](../reading-list.md) for background.\n\nAlso [re";
      const lines = draft.split("\n");
      const completions = await iwe.complete(
        root,
        "projects/continuum",
        draft,
        lines.length - 1,
        lines.at(-1)!.length,
      );
      // A new workspace keeps IWE's default link style, which has no extension.
      expect(completions.find((item) => item.label === "Reading list")?.insertText).toMatch(
        /^\[Reading list\]\(\.\.\/reading-list(\.md)?\)$/,
      );

      const note = await iwe.note(root, "projects/continuum");
      await expect(
        iwe.renameLink(root, note.key, note.content + "\nUnsaved changes.\n", 2, 20, "../books"),
      ).rejects.toThrow("Save or reopen this note before renaming a link target.");
      expect(await NodeFSP.readFile(note.path, "utf8")).toBe(note.content);

      const renamed = await iwe.renameLink(root, note.key, note.content, 2, 20, "../books");
      expect(renamed.changedFiles).toEqual(expect.arrayContaining(["projects/continuum.md"]));
      expect(await NodeFSP.readFile(NodePath.join(root, "projects/continuum.md"), "utf8")).toMatch(
        /\]\(\.\.\/books(\.md)?\)/,
      );
      await expect(NodeFSP.access(NodePath.join(root, "books.md"))).resolves.toBeUndefined();

      await iwe.rename(root, "books", "library/books");
      expect(await NodeFSP.readFile(NodePath.join(root, "projects/continuum.md"), "utf8")).toMatch(
        /\]\(\.\.\/library\/books(\.md)?\)/,
      );

      const threadId = ThreadId.make("thread-iwe");
      await iwe.attach(threadId, root, "projects/continuum", 1, null);
      const context = await iwe.contextForTurn(threadId, root);
      expect(context).toContain(`IWE notes workspace at ${root}`);
      expect(context).toContain("#projects/continuum");
      expect(context).toContain("#library/books");
      expect((await iwe.threadState(threadId, root)).attachments).toEqual([]);
      expect((await iwe.threadState(threadId, root)).activity.map((entry) => entry.action)).toEqual(
        ["read", "attached"],
      );
    } finally {
      iwe.stop();
    }
  });
});

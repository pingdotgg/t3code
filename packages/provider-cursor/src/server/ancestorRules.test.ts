import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { readCursorRulesAboveWorkspace } from "./ancestorRules.ts";

const always = (body: string) => `---\nalwaysApply: true\n---\n${body}\n`;

// The walk stops at `top`, so the host's real ancestors never reach the output.
const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const top = yield* fileSystem.makeTempDirectoryScoped({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-ancestor-rules-",
  });
  const write = Effect.fnUntraced(function* (file: string, contents: string | Uint8Array) {
    const target = path.join(top, file);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    if (typeof contents === "string") yield* fileSystem.writeFileString(target, contents);
    else yield* fileSystem.writeFile(target, contents);
    return target;
  });
  const workspace = path.join(top, "mid", "ws");
  yield* fileSystem.makeDirectory(workspace, { recursive: true });
  const readRoot = (root: string) =>
    Effect.map(readCursorRulesAboveWorkspace(root, top), (rules) => rules ?? "");
  const read = readRoot(workspace);
  return { fileSystem, path, top, workspace, write, readRoot, read };
});

const indexOfMarker = (output: string, marker: string) => {
  const index = output.indexOf(marker);
  assert.isAtLeast(index, 0, `${marker} is missing`);
  return index;
};

describe("readCursorRulesAboveWorkspace", () => {
  it.effect("orders levels closest first and files within a level like the SDK", () =>
    Effect.gen(function* () {
      const { write, read } = yield* fixture;
      yield* write(".cursor/rules/sub/a.mdc", always("MARK-TOP-SUB-A"));
      yield* write(".cursor/rules/b.mdc", always("MARK-TOP-B"));
      yield* write("CLAUDE.md", "MARK-TOP-CLAUDE");
      yield* write("CLAUDE.local.md", "MARK-TOP-CLAUDE-LOCAL");
      yield* write("AGENTS.md", "MARK-TOP-AGENTS");
      yield* write("mid/.cursor/rules/z.mdc", always("MARK-MID-Z"));
      yield* write("mid/AGENTS.md", "MARK-MID-AGENTS");

      const output = yield* read;
      const order = [
        "MARK-MID-Z",
        "MARK-MID-AGENTS",
        "MARK-TOP-B",
        "MARK-TOP-SUB-A",
        "MARK-TOP-CLAUDE\n",
        "MARK-TOP-CLAUDE-LOCAL",
        "MARK-TOP-AGENTS",
      ].map((marker) => indexOfMarker(output, marker));
      assert.deepEqual(
        order,
        order.toSorted((left, right) => left - right),
      );
      assert.isTrue(output.startsWith("<user_rules>\n"));
      assert.isTrue(output.endsWith("</user_rules>"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "skips files inside the workspace, including through symlinks",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, top, workspace, write, readRoot, read } = yield* fixture;
        yield* write("mid/ws/.cursor/rules/in.mdc", always("MARK-IN-WORKSPACE"));
        yield* write("mid/ws/AGENTS.md", "MARK-WORKSPACE-AGENTS");
        const target = yield* write(
          "mid/ws/outside-target.mdc",
          always("MARK-LINKED-INTO-WORKSPACE"),
        );
        yield* write(".cursor/rules/keep.mdc", always("MARK-KEPT"));
        yield* fileSystem.symlink(target, path.join(top, ".cursor/rules/link.mdc"));
        const linkedRoot = path.join(top, "root-link");
        yield* fileSystem.symlink(workspace, linkedRoot);

        for (const output of [yield* read, yield* readRoot(linkedRoot)]) {
          indexOfMarker(output, "MARK-KEPT");
          assert.notInclude(output, "MARK-IN-WORKSPACE");
          assert.notInclude(output, "MARK-WORKSPACE-AGENTS");
          assert.notInclude(output, "MARK-LINKED-INTO-WORKSPACE");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("inlines always rules and only lists requestable ones", () =>
    Effect.gen(function* () {
      const { write, read } = yield* fixture;
      const rules = ".cursor/rules/";
      const description = yield* write(
        `${rules}desc.mdc`,
        '---\ndescription: "Use for API work"\n---\nBODY-DESC',
      );
      const globString = yield* write(
        `${rules}globs.mdc`,
        "---\nglobs: *.ts,*.tsx\n---\nBODY-GLOBS",
      );
      const globList = yield* write(
        `${rules}list.mdc`,
        "---\nglobs:\n  - src/**/*.rs\n  - '*.toml'\n---\nBODY-LIST",
      );
      const colon = yield* write(
        `${rules}colon.mdc`,
        "---\ndescription: Use when: x\n---\nBODY-COLON",
      );
      const upper = yield* write(`${rules}upper.mdc`, "---\nalwaysApply: True\n---\nBODY-UPPER");
      const quoted = yield* write(
        `${rules}quoted.mdc`,
        '---\nalwaysApply: "true"\ndescription: Quoted flag\n---\nBODY-QUOTED',
      );
      const quotedList = yield* write(
        `${rules}quoted-list.mdc`,
        '---\nglobs:\n  - "*.ts"\n  - src/**\n---\nBODY-QLIST',
      );
      yield* write(`${rules}indented.mdc`, "---\n  alwaysApply: true\n---\nBODY-INDENTED");
      yield* write(`${rules}manual.mdc`, "---\nalwaysApply: false\n---\nBODY-MANUAL");
      yield* write(`${rules}plain.mdc`, "BODY-NOFRONTMATTER");
      yield* write(`${rules}note.md`, "---\nalwaysApply: true\n---\nBODY-MARKDOWN");
      yield* write(`${rules}always.mdc`, always("BODY-ALWAYS"));

      const output = yield* read;
      indexOfMarker(output, "BODY-ALWAYS");
      indexOfMarker(output, "BODY-INDENTED");
      assert.include(output, `- ${quoted}: Quoted flag`);
      assert.include(output, `- ${quotedList} (applies to files matching *.ts, src/**)`);
      assert.notInclude(output, upper);
      assert.include(output, `- ${description}: Use for API work`);
      assert.include(output, `- ${globString} (applies to files matching *.ts, *.tsx)`);
      assert.include(output, `- ${globList} (applies to files matching src/**/*.rs, *.toml)`);
      assert.include(output, `- ${colon}: Use when: x`);
      for (const skipped of [
        "BODY-DESC",
        "BODY-GLOBS",
        "BODY-LIST",
        "BODY-COLON",
        "BODY-MANUAL",
        "BODY-NOFRONTMATTER",
        "BODY-MARKDOWN",
        "BODY-QUOTED",
        "BODY-QLIST",
        "BODY-UPPER",
        "manual.mdc",
        "plain.mdc",
        "note.md",
      ]) {
        assert.notInclude(output, skipped);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("loads BOM and CRLF rules as an LF body without frontmatter", () =>
    Effect.gen(function* () {
      const { write, read } = yield* fixture;
      yield* write(
        ".cursor/rules/crlf.mdc",
        "﻿---\r\nalwaysApply: true\r\n---\r\nBODY-CRLF\r\nsecond line\r\n",
      );
      const output = yield* read;
      assert.include(output, "BODY-CRLF\nsecond line\n</rule>");
      assert.notInclude(output, "\r");
      assert.notInclude(output, "﻿");
      assert.notInclude(output, "alwaysApply");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a rule whole when the filesystem returns short reads", () =>
    Effect.gen(function* () {
      const { fileSystem, write, read } = yield* fixture;
      yield* write("AGENTS.md", "MARK-START then more text after the first chunk MARK-END");
      const shortReads: FileSystem.FileSystem = {
        ...fileSystem,
        open: (file, options) =>
          Effect.map(
            fileSystem.open(file, options),
            (handle) =>
              new Proxy(handle, {
                get: (target, key, receiver) =>
                  key === "readAlloc"
                    ? (size: number) => target.readAlloc(Math.min(size, 7))
                    : Reflect.get(target, key, receiver),
              }),
          ),
      };
      const output = yield* read.pipe(Effect.provideService(FileSystem.FileSystem, shortReads));
      assert.isBelow(indexOfMarker(output, "MARK-START"), indexOfMarker(output, "MARK-END"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("truncates oversized rules at a UTF-8 boundary instead of skipping them", () =>
    Effect.gen(function* () {
      const { write, read } = yield* fixture;
      const encoder = new TextEncoder();
      // 102399 ASCII bytes, so the 102400-byte limit lands inside the first 3-byte "€".
      const big = (head: string) =>
        encoder.encode(
          `${head}${"a".repeat(102_399 - head.length)}${"€".repeat(20_000)}MARK-AFTER`,
        );
      const markdown = big("MARK-BEFORE-MD");
      const mdc = encoder.encode(
        `${always("MARK-BEFORE-MDC")}${"b".repeat(102_400)}MARK-AFTER-MDC`,
      );
      yield* write("AGENTS.md", markdown);
      yield* write(".cursor/rules/big.mdc", mdc);

      const output = yield* read;
      indexOfMarker(output, "MARK-BEFORE-MD");
      indexOfMarker(output, "MARK-BEFORE-MDC");
      const notice = (name: string, size: number) =>
        `[truncated: ${name} is ${Math.round(size / 1024)} KB; only the first 100 KB is included]`;
      indexOfMarker(output, notice("AGENTS.md", markdown.length));
      indexOfMarker(output, notice("big.mdc", mdc.length));
      assert.notInclude(output, "�");
      assert.notInclude(output, "MARK-AFTER");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)("keeps one copy of duplicate markdown rules", () =>
    Effect.gen(function* () {
      const { fileSystem, path, top, write, read } = yield* fixture;
      const agents = yield* write("AGENTS.md", "MARK-SHARED-TOP");
      yield* fileSystem.symlink(agents, path.join(top, "CLAUDE.md"));
      yield* write("mid/AGENTS.md", "MARK-SHARED-TOP");
      yield* write("mid/CLAUDE.md", "MARK-MID-ONLY");

      const output = yield* read;
      assert.include(output, `<rule path="${agents}">`);
      assert.notInclude(output, `<rule path="${path.join(top, "CLAUDE.md")}">`);
      assert.notInclude(output, `<rule path="${path.join(top, "mid", "AGENTS.md")}">`);
      assert.strictEqual(output.split("MARK-SHARED-TOP").length - 1, 1);
      indexOfMarker(output, "MARK-MID-ONLY");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Root and Windows can read a 0o000 file.
  it.effect.skipIf(process.getuid?.() === 0 || HostProcess.Platform.defaultValue() === "win32")(
    "skips unreadable files without failing",
    () =>
      Effect.gen(function* () {
        const { fileSystem, write, read } = yield* fixture;
        const locked = yield* write("mid/AGENTS.md", "MARK-LOCKED");
        yield* write("CLAUDE.md", "MARK-READABLE");
        yield* fileSystem.chmod(locked, 0o000);
        const output = yield* read;
        indexOfMarker(output, "MARK-READABLE");
        assert.notInclude(output, "MARK-LOCKED");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - Exercises the patched Knip CLI against a disposable project.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const cli = NodePath.join(NodePath.dirname(require.resolve("knip")), "cli.js");

it("counts pnpm workspace overrides without hiding unused or missing catalog entries", () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-knip-catalogs-"));
  const write = (file: string, content: string) =>
    NodeFS.writeFileSync(NodePath.join(cwd, file), content);
  const run = () =>
    NodeChildProcess.spawnSync(
      NodeProcess.execPath,
      [
        cli,
        "--directory",
        cwd,
        "--include",
        "catalog,catalogReferences",
        "--reporter",
        "json",
        "--no-config-hints",
      ],
      { encoding: "utf8" },
    );
  const workspace = `packages: []
catalog:
  override-only: 1.0.0
  version-range: 1.0.0
  legacy: 1.0.0
  unused: 1.0.0
catalogs:
  native:
    '@scope/native': 2.0.0
overrides:
  override-only: 'catalog:'
  'version-range@>=1': 'catalog:'
  'parent@1>@scope/native@2': 'catalog:native'
  missing: 'catalog:'
  plain-version: 3.0.0
`;
  try {
    write(
      "package.json",
      JSON.stringify({
        name: "catalog-fixture",
        private: true,
        pnpm: { overrides: { "parent@>=1>legacy@>=1": "catalog:" } },
      }),
    );
    write("knip.json", JSON.stringify({ entry: ["index.js"], project: ["index.js"] }));
    write("index.js", "console.log('fixture');\n");
    write("pnpm-workspace.yaml", workspace);

    const findings = run();
    expect(findings.status, findings.stderr).toBe(1);
    expect(JSON.parse(findings.stdout).issues).toEqual([
      expect.objectContaining({
        file: "pnpm-workspace.yaml",
        catalog: [expect.objectContaining({ name: "unused" })],
        catalogReferences: [
          expect.objectContaining({
            name: "missing",
            line: workspace.split("\n").findIndex((line) => line.startsWith("  missing:")) + 1,
            col: 3,
          }),
        ],
      }),
    ]);

    write(
      "pnpm-workspace.yaml",
      workspace.replace("  unused: 1.0.0\n", "").replace("  missing: 'catalog:'\n", ""),
    );
    const clean = run();
    expect(clean.status, clean.stderr + clean.stdout).toBe(0);
    expect(JSON.parse(clean.stdout).issues).toEqual([]);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

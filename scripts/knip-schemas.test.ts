// @effect-diagnostics nodeBuiltinImport:off - Runs the real Knip CLI against a disposable on-disk project.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const cli = NodePath.join(NodePath.dirname(require.resolve("knip")), "cli.js");
const preprocessor = NodePath.join(import.meta.dirname, "knip-schemas.ts");

it("allows types and schemas through the real Knip CLI without hiding runtime or file findings", () => {
  // Keeping the disposable project here gives it the same Effect installation as the scripts.
  const cwd = NodeFS.mkdtempSync(NodePath.join(import.meta.dirname, ".knip-test-"));
  const write = (file: string, content: string) =>
    NodeFS.writeFileSync(NodePath.join(cwd, file), content);
  const run = (filtered: boolean) =>
    NodeChildProcess.spawnSync(
      NodeProcess.execPath,
      [
        cli,
        "--directory",
        cwd,
        "--config",
        NodePath.join(cwd, "knip.json"),
        "--no-config-hints",
        "--include",
        "files,dependencies,exports,nsExports,types,nsTypes,duplicates",
        "--reporter",
        "json",
        ...(filtered ? ["--preprocessor", preprocessor] : []),
      ],
      { encoding: "utf8" },
    );
  try {
    write(
      "package.json",
      JSON.stringify({ private: true, type: "module", dependencies: { effect: "*" } }),
    );
    write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { module: "NodeNext", strict: true } }),
    );
    write(
      "knip.json",
      JSON.stringify({
        entry: ["entry.ts"],
        project: ["*.ts"],
        includeEntryExports: true,
        include: [
          "exports",
          "nsExports",
          "types",
          "nsTypes",
          "duplicates",
          "files",
          "dependencies",
        ],
        rules: { types: "off", nsTypes: "off" },
      }),
    );
    write(
      "entry.ts",
      `
      import * as S from "effect/Schema";
      import * as ns from "./namespace.ts";
      console.log(ns);
      export { Remote as Reexported } from "./remote.ts";
      export const Text = S.String;
      export const Alias = Text;
      const Internal = S.Boolean;
      export type Internal = typeof Internal.Type;
      export const PublicAlias = Internal;
      export default Text;
      export const Record = S.Struct({ name: Text }).annotate({ title: "record" });
      export const Branded = S.String.pipe(S.brand("Name"));
      export class Failure extends S.TaggedErrorClass<Failure>()("Failure", { reason: Text }) {}
      export class Person extends S.Class<Person>("Person")({ name: Text }) {}
      export type UnusedType = { name: string };
      export interface UnusedInterface { name: string }
    `,
    );
    write(
      "remote.ts",
      `
      import { Schema as S } from "effect";
      export const Remote = S.Struct({ id: S.Number });
      throw new Error("The preprocessor must never evaluate application modules");
    `,
    );
    write(
      "namespace.ts",
      `
      import * as S from "effect/Schema";
      export const Unused = S.Number;
      export type UnusedType = string;
    `,
    );
    const baseline = run(false);
    expect(baseline.status, baseline.stderr).toBe(1);
    expect(baseline.stdout).toContain('"Text"');
    const allowed = run(true);
    expect(allowed.status, allowed.stderr + allowed.stdout).toBe(0);
    expect(JSON.parse(allowed.stdout).issues).toEqual([]);

    NodeFS.appendFileSync(
      NodePath.join(cwd, "entry.ts"),
      `
      export const decode = S.decodeUnknownSync(Text);
      export const makeSchema = () => S.String;
      export const LooksLikeSchema = { ast: "not a schema" };
      export const ordinary = 123;
      export const duplicate = ordinary;
    `,
    );
    NodeFS.appendFileSync(NodePath.join(cwd, "namespace.ts"), `export const helper = () => 1;`);
    write("unused.ts", `export const orphan = 1;`);
    write(
      "package.json",
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { effect: "*", "unused-knip-fixture-dependency": "*" },
      }),
    );
    const rejected = run(true);
    expect(rejected.status, rejected.stderr).toBe(1);
    const issues = JSON.parse(rejected.stdout).issues;
    const entry = issues.find((issue: { file: string }) => issue.file === "entry.ts");
    expect(entry.exports.map((issue: { name: string }) => issue.name).sort()).toEqual([
      "LooksLikeSchema",
      "decode",
      "duplicate",
      "makeSchema",
      "ordinary",
    ]);
    expect(entry.duplicates).toHaveLength(1);
    expect(
      issues.find((issue: { file: string }) => issue.file === "namespace.ts").nsExports,
    ).toEqual([expect.objectContaining({ name: "helper" })]);
    expect(issues.find((issue: { file: string }) => issue.file === "unused.ts").files).toHaveLength(
      1,
    );
    expect(
      issues.find((issue: { file: string }) => issue.file === "package.json").dependencies,
    ).toEqual([expect.objectContaining({ name: "unused-knip-fixture-dependency" })]);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

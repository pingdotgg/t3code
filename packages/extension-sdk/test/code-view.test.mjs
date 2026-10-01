import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { resolveCodeView } from "../dist/environment.js";

const sdk = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const Diff = () => null;
const File = () => null;

NodeTest.describe("resolveCodeView", () => {
  NodeTest.it("is null on hosts without the member", () => {
    NodeAssert.equal(resolveCodeView({}), null);
    NodeAssert.equal(resolveCodeView({ codeView: undefined }), null);
  });

  NodeTest.it("returns a version 1 member unchanged", () => {
    const codeView = { version: 1, Diff, File };
    NodeAssert.equal(resolveCodeView({ codeView }), codeView);
  });

  NodeTest.it("accepts a later version that still carries the v1 components", () => {
    const codeView = { version: 2, Diff, File, annotations: true };
    NodeAssert.equal(resolveCodeView({ codeView }), codeView);
  });

  NodeTest.it("accepts memo/lazy component objects", () => {
    const codeView = { version: 1, Diff: { $$typeof: Symbol.for("react.memo") }, File };
    NodeAssert.equal(resolveCodeView({ codeView }), codeView);
  });

  NodeTest.it("rejects malformed members instead of rendering them", () => {
    for (const codeView of [
      null,
      "codeView",
      { version: 0, Diff, File },
      { version: "1", Diff, File },
      { version: 1, Diff },
      { version: 1, Diff: "div", File },
      { version: 1, Diff: [], File },
      { version: 1, Diff: {}, File },
    ])
      NodeAssert.equal(resolveCodeView({ codeView }), null, JSON.stringify(codeView));
  });
});

NodeTest.it("types the member as optional plain-data props", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-view-types-"));
  try {
    const environment = NodePath.join(sdk, "dist/environment.js").replaceAll("\\", "/");
    await NodeFSP.writeFile(
      NodePath.join(dir, "check.ts"),
      `import { resolveCodeView, type ClientHost, type CodeViewDiffProps, type CodeViewFileProps } from ${JSON.stringify(environment)};
declare const host: ClientHost;
// @ts-expect-error the member is optional: plugins must feature-detect it
host.codeView.Diff;
const codeView = resolveCodeView(host);
if (codeView !== null) {
  const version: number = codeView.version;
  void version;
  const diff: CodeViewDiffProps = { patch: "", layout: "split", wordWrap: false };
  // @ts-expect-error layout is the two native layouts only
  const badLayout: CodeViewDiffProps = { patch: "", layout: "stacked", wordWrap: false };
  const file: CodeViewFileProps = { path: "a.ts", contents: "", reveal: { line: 3, requestId: 1 } };
  // @ts-expect-error reveal requests carry an id so repeats re-run
  const badReveal: CodeViewFileProps = { path: "a.ts", contents: "", reveal: { line: 3 } };
  const load: NonNullable<CodeViewDiffProps["loadContents"]> = async () => ({ oldContents: "", newContents: "" });
  void diff; void badLayout; void file; void badReveal; void load;
}
`,
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: true,
          lib: ["ES2022", "DOM"],
          typeRoots: [NodePath.join(sdk, "node_modules/@types")],
        },
        include: ["check.ts"],
      }),
    );
    const result = NodeChildProcess.spawnSync(
      NodePath.join(sdk, "node_modules/.bin/tsc"),
      ["-p", dir],
      { encoding: "utf8" },
    );
    NodeAssert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

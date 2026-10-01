import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

NodeTest.test(
  "Electron-as-Node installs the public package and invokes its actual worker",
  {
    skip: !process.env.T3_EXTENSION_TEST_ELECTRON,
    timeout: 20000,
  },
  async (t) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-electron-runtime-"));
    t.after(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const source = NodeURL.fileURLToPath(
      new URL("../../extension-sdk/examples/installable-workspace-reader/", import.meta.url),
    );
    const runtimeUrl = new URL("../dist/index.js", import.meta.url).href;
    const program = `
    import { createExtensionRuntime } from ${JSON.stringify(runtimeUrl)};
    import assert from "node:assert/strict";
    assert.ok(process.versions.electron);
    const context = { resource: { namespace: "t3.thread", id: "thread-a", environmentId: "env-a", projectId: "project-a", threadId: "thread-a" }, workspaceRevision: "revision-a", client: "desktop" };
    let serviceCalls = 0;
    const runtime = await createExtensionRuntime({
      rootDir: ${JSON.stringify(root)}, environmentId: "env-a", timeoutMs: 5000,
      authorize: () => true,
      services: [{ capability: "t3.workspace/read-text", invoke(input, actual) {
        assert.deepEqual(actual, context); serviceCalls++;
        return { relativePath: input.relativePath, contents: "Electron child read proof", byteLength: 25, truncated: false };
      } }],
    });
    try {
      const installed = await runtime.install(${JSON.stringify(source)}, { capabilities: ["t3.workspace/read-text"], projectIds: ["project-a"] });
      const result = await runtime.invoke("example.installed-reader/read", { relativePath: "README.md" }, context, new AbortController().signal, installed.contentHash);
      assert.equal(result.contents, "Electron child read proof");
      assert.equal(serviceCalls, 1);
      console.log(JSON.stringify({ electron: process.versions.electron, installed: installed.id, invoked: true }));
    } finally { await runtime.dispose(); }
  `;
    const result = await new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        process.env.T3_EXTENSION_TEST_ELECTRON,
        ["--input-type=module", "--eval", program],
        {
          env: { PATH: process.env.PATH ?? "", ELECTRON_RUN_AS_NODE: "1" },
          timeout: 15000,
          maxBuffer: 65536,
        },
        (error, stdout, stderr) =>
          error ? reject(new Error(String(error) + "\n" + stderr)) : resolve(stdout),
      );
    });
    NodeAssert.equal(JSON.parse(result.trim()).invoked, true);
  },
);

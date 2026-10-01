import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { createExtensionRuntime } from "../dist/index.js";

const capability = "t3.workspace/read-text";
const context = {
  resource: {
    namespace: "t3.thread",
    id: "thread-a",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
  workspaceRevision: "revision-a",
  client: "web",
};
const workerPath = NodeURL.fileURLToPath(new URL("../dist/worker.js", import.meta.url));
const heapLimit = "--max-old-space-size=96";

// Reports how the host started the worker process, from inside that process.
// Node adds the IPC channel variables and macOS adds __CF_USER_TEXT_ENCODING.
const server = `import * as NodeV8 from "node:v8";
export default {tools:[{id:"test.launch/process",invoke:()=>({
  argv:process.argv,
  execArgv:process.execArgv,
  cwd:process.cwd(),
  env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(NODE_CHANNEL_|__CF_)/.test(key))),
  heapLimitMb:Math.round(NodeV8.getHeapStatistics().heap_size_limit/1048576),
})}]};`;

async function launchedWorker(t, launch) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-worker-launch-"));
  t.after(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const source = NodePath.join(directory, "source");
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(
    NodePath.join(source, "t3-extension.json"),
    JSON.stringify({
      format: 1,
      manifest: { id: "test.launch", version: "1.0.0", apiVersion: 1, surfaces: [] },
      serverEntry: "server.mjs",
      tools: [
        {
          id: "test.launch/process",
          title: "process",
          description: "Fixture process",
          readOnly: true,
          capabilities: [capability],
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    }),
  );
  await NodeFSP.writeFile(NodePath.join(source, "server.mjs"), server);
  const runtime = await createExtensionRuntime({
    rootDir: NodePath.join(directory, "state"),
    environmentId: "env-a",
    services: [{ capability, invoke: (input) => input }],
    authorize: () => true,
    timeoutMs: 5000,
    ...launch,
  });
  t.after(() => runtime.dispose());
  const installed = await runtime.install(source, {
    capabilities: [capability],
    projectIds: ["project-a"],
  });
  const report = await runtime.invoke(
    "test.launch/process",
    {},
    context,
    new AbortController().signal,
    installed.contentHash,
  );
  return { installed, report };
}

NodeTest.test("forks the worker script with the heap cap as a Node flag", async (t) => {
  const { installed, report } = await launchedWorker(t, {});
  NodeAssert.deepEqual(report.argv, [process.execPath, workerPath]);
  NodeAssert.deepEqual(report.execArgv, [heapLimit]);
  NodeAssert.deepEqual(report.env, {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
  });
  NodeAssert.equal(NodePath.basename(report.cwd), installed.contentHash);
  NodeAssert.ok(report.heapLimitMb < 1024, `heap limit ${report.heapLimitMb}MB`);
});

NodeTest.test(
  "runs workerCommand on the host executable with the heap cap in NODE_OPTIONS",
  async (t) => {
    // An executable host passes ["__extension-worker"]; a plain Node host proves
    // the same spawn with the worker script as its command.
    const { installed, report } = await launchedWorker(t, { workerCommand: [workerPath] });
    NodeAssert.deepEqual(report.argv, [process.execPath, workerPath]);
    NodeAssert.deepEqual(report.execArgv, []);
    NodeAssert.deepEqual(report.env, {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: heapLimit,
    });
    NodeAssert.equal(NodePath.basename(report.cwd), installed.contentHash);
    NodeAssert.ok(report.heapLimitMb < 1024, `heap limit ${report.heapLimitMb}MB`);
  },
);

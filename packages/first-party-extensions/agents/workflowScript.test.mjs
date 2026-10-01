import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const sdkRequire = NodeModule.createRequire(
  new URL("../../extension-sdk/package.json", import.meta.url),
);
const React = sdkRequire("react");
const { act, create } = sdkRequire("react-test-renderer");
const { build } = sdkRequire("esbuild");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "agents-script-test-"));
await build({
  entryPoints: [NodeURL.fileURLToPath(new URL("./extension.tsx", import.meta.url))],
  outfile: NodePath.join(directory, "extension.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  plugins: [
    {
      name: "shared-react",
      setup(builder) {
        builder.onResolve({ filter: /^react(?:\/|$)/ }, ({ path }) => ({
          path: sdkRequire.resolve(path),
          external: true,
        }));
      },
    },
  ],
});
const { default: extension } = await import(
  NodeURL.pathToFileURL(NodePath.join(directory, "extension.mjs")).href
);
NodeTest.after(() => NodeFSP.rm(directory, { recursive: true, force: true }));

const rawError =
  "Failed to fetch remote environment endpoint http://localhost:5790/api/extensions/api/invoke (ExtensionOperationError: Script path is outside the workflow scripts root.).";
const textOf = (node) =>
  typeof node === "string"
    ? node
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : (node?.children ?? []).map(textOf).join("");
const workflow = {
  id: "workflow",
  kind: "workflow",
  title: "Workflow",
  status: "completed",
  role: null,
  model: null,
  taskType: "local_workflow",
  detail: null,
  tokenUsage: null,
  result: null,
  error: null,
  outputFile: null,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: { scriptPath: "/home/.claude/projects/proof/workflow.js" },
  recentActivity: [],
  firstSeenAt: "2026-09-30T00:00:00.000Z",
  startedAt: "2026-09-30T00:00:00.000Z",
  completedAt: "2026-09-30T00:00:01.000Z",
  updatedAt: "2026-09-30T00:00:01.000Z",
};

async function renderPanel({
  contents = "export default 1;",
  failure = false,
  failuresBeforeSuccess = 0,
  pending = null,
  capabilityFailure = false,
} = {}) {
  let scriptReads = 0;
  const controller = new AbortController();
  const host = {
    React,
    async invokeApi(request) {
      if (request.method === "getCapabilities") {
        if (capabilityFailure) throw new Error(rawError);
        return {
          operations: { readWorkflowScript: true },
          streamEpoch: "epoch",
          revision: 1,
        };
      }
      if (request.method === "readText") return { contents: "{}", truncated: false };
      throw new Error("Unavailable in fixture");
    },
    async *subscribeApi(request, signal) {
      if (request.name === "readWorkflowScript") {
        scriptReads += 1;
        if (failure || scriptReads <= failuresBeforeSuccess) throw new Error(rawError);
        if (pending) await pending;
        const chunks = contents.match(/[\s\S]{1,8192}/gu) ?? [];
        yield {
          type: "snapshot",
          value: {
            kind: "manifest",
            chunkCount: chunks.length,
            truncated: false,
          },
        };
        for (const [chunkIndex, data] of chunks.entries())
          yield { type: "data", value: { kind: "chunk", chunkIndex, data } };
        yield {
          type: "closed",
          value: {
            kind: "complete",
            sha256: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
          },
        };
        return;
      }
      if (request.name !== "subscribeAgents") return;
      yield {
        type: "snapshot",
        value: {
          kind: "snapshot",
          streamEpoch: "epoch",
          revision: 1,
          agents: [workflow],
          pendingApprovals: [],
          pendingUserInputs: [],
          checkpoints: [],
          session: null,
          turn: null,
          receipts: [],
          retention: { agentsCap: 100, receiptsCap: 100 },
        },
      };
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  };
  const session = {
    context: {
      workspaceRevision: "revision",
      resource: { threadId: "thread", projectId: "project" },
    },
    visible: true,
    signal: controller.signal,
    onVisibility: () => () => {},
    setTabIndicators: () => {},
  };
  let root;
  await act(async () => {
    root = create(
      React.createElement(extension.client(host).surfaces[0].createView(session).renderer),
    );
  });
  const toggle = () =>
    root.root
      .findAllByType("button")
      .find((button) => textOf(button).toLowerCase().includes("script"));
  return {
    root,
    toggle,
    reads: () => scriptReads,
    async clickToggle() {
      NodeAssert.ok(toggle(), textOf(root.toJSON()));
      await act(async () => toggle().props.onClick());
    },
    async close() {
      await act(async () => {
        controller.abort();
        root.unmount();
      });
    },
  };
}

NodeTest.test("D1: script refusal uses native wording without transport details", async () => {
  const panel = await renderPanel({ failure: true });
  try {
    await panel.clickToggle();
    const text = textOf(panel.root.toJSON());
    NodeAssert.ok(text.includes("Could not load the script."), text);
    NodeAssert.ok(!text.includes(rawError), text);
  } finally {
    await panel.close();
  }
});

NodeTest.test("D1: capability failures never expose raw remote endpoint errors", async () => {
  const panel = await renderPanel({ capabilityFailure: true });
  try {
    NodeAssert.ok(!textOf(panel.root.toJSON()).includes(rawError));
  } finally {
    await panel.close();
  }
});

NodeTest.test(
  "D2: script viewer renders all 16,087 characters without a truncation marker",
  async () => {
    const contents = "a".repeat(16_087);
    const panel = await renderPanel({ contents });
    try {
      await panel.clickToggle();
      NodeAssert.equal(textOf(panel.root.root.findByType("pre")), contents);
    } finally {
      await panel.close();
    }
  },
);

NodeTest.test("D3: toggle and Close hide the script; reopening uses the cached read", async () => {
  const panel = await renderPanel();
  try {
    await panel.clickToggle();
    NodeAssert.equal(panel.root.root.findAllByType("pre").length, 1);
    await panel.clickToggle();
    NodeAssert.equal(panel.root.root.findAllByType("pre").length, 0);
    await panel.clickToggle();
    NodeAssert.equal(panel.root.root.findAllByType("pre").length, 1);
    const close = panel.root.root.findByProps({ "aria-label": "Close script" });
    await act(async () => close.props.onClick());
    NodeAssert.equal(panel.root.root.findAllByType("pre").length, 0);
    await panel.clickToggle();
    NodeAssert.equal(panel.reads(), 1);
    NodeAssert.equal(textOf(panel.root.root.findByType("pre")), "export default 1;");
  } finally {
    await panel.close();
  }
});

NodeTest.test(
  "closing a loading script stays closed after completion and does not duplicate the read",
  async () => {
    const pending = Promise.withResolvers();
    const panel = await renderPanel({ pending: pending.promise });
    let opening;
    try {
      await act(async () => {
        opening = panel.toggle().props.onClick();
      });
      NodeAssert.ok(textOf(panel.root.toJSON()).includes("Loading…"));
      await panel.clickToggle();
      NodeAssert.equal(panel.toggle().props["aria-expanded"], false);
      await act(async () => {
        pending.resolve();
        await opening;
      });
      NodeAssert.equal(panel.root.root.findAllByType("pre").length, 0);
      await panel.clickToggle();
      NodeAssert.equal(panel.reads(), 1);
      NodeAssert.equal(textOf(panel.root.root.findByType("pre")), "export default 1;");
    } finally {
      pending.resolve();
      await panel.close();
    }
  },
);

NodeTest.test(
  "reopening a failed script retries the read and keeps native failure wording",
  async () => {
    const panel = await renderPanel({ failure: true });
    try {
      await panel.clickToggle();
      await panel.clickToggle();
      NodeAssert.ok(!textOf(panel.root.toJSON()).includes("Could not load the script."));
      await panel.clickToggle();
      NodeAssert.ok(textOf(panel.root.toJSON()).includes("Could not load the script."));
      NodeAssert.equal(panel.reads(), 2);
    } finally {
      await panel.close();
    }
  },
);

NodeTest.test(
  "reopening after a transient script failure loads and caches the successful read",
  async () => {
    const panel = await renderPanel({ failuresBeforeSuccess: 1 });
    try {
      await panel.clickToggle();
      NodeAssert.ok(textOf(panel.root.toJSON()).includes("Could not load the script."));
      await panel.clickToggle();
      await panel.clickToggle();
      NodeAssert.equal(textOf(panel.root.root.findByType("pre")), "export default 1;");
      NodeAssert.equal(panel.reads(), 2);
      await panel.clickToggle();
      await panel.clickToggle();
      NodeAssert.equal(panel.reads(), 2);
    } finally {
      await panel.close();
    }
  },
);

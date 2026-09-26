import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import React from "react";
import TestRenderer from "react-test-renderer";
import createBaseline from "../examples/installable-files/client.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const sdk = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const source = NodePath.join(sdk, "examples/files");

function run(command, args, cwd) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  return {
    command,
    args,
    cwd,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function buildCandidate() {
  const proofRoot = process.env.T3_FILES_PROOF_ROOT ?? NodeOS.tmpdir();
  await NodeFSP.mkdir(proofRoot, { recursive: true });
  const root = await NodeFSP.mkdtemp(NodePath.join(proofRoot, "t3-files-"));
  const candidate = NodePath.join(root, "candidate");
  const builderReceipt = NodePath.join(root, "receipts.json");
  await NodeFSP.mkdir(NodePath.dirname(builderReceipt), { recursive: true });
  const calls = [];
  const pack = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], sdk);
  calls.push(pack);
  NodeAssert.equal(pack.exitCode, 0, pack.stderr || pack.stdout);
  const sdkTarball = NodePath.join(root, JSON.parse(pack.stdout)[0].filename);
  await NodeFSP.mkdir(candidate, { recursive: true });
  await NodeFSP.cp(source, candidate, { recursive: true });
  const packagePath = NodePath.join(candidate, "package.json");
  const packageJson = JSON.parse(await NodeFSP.readFile(packagePath, "utf8"));
  packageJson.devDependencies["@t3tools/extension-sdk"] = `file:${sdkTarball}`;
  await NodeFSP.writeFile(packagePath, JSON.stringify(packageJson, null, 2) + "\n");
  calls.push(run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], candidate));
  calls.push(run("npm", ["run", "build"], candidate));
  calls.push(run("npm", ["run", "check"], candidate));
  // The receipt pins the checkout the SDK tarball was packed from —
  // without it a proof could silently drift from the source it claims.
  const head = run("git", ["rev-parse", "HEAD"], sdk);
  const dirty = run("git", ["status", "--porcelain"], sdk);
  calls.push(head, dirty);
  const callRecords = calls.map(({ stdout, stderr, ...call }) => ({ ...call, stdout, stderr }));
  const checkout = {
    commit: head.stdout.trim(),
    dirty: dirty.stdout.trim().length > 0,
  };
  const sourceHashes = {};
  for (const name of await NodeFSP.readdir(source)) {
    sourceHashes[name] = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(NodePath.join(source, name)))
      .digest("hex");
  }
  const failed = calls.find((call) => call.exitCode !== 0);
  if (failed) {
    const receipt = JSON.stringify(
      {
        kind: "typed-files-builder",
        candidate,
        sdkTarball,
        calls: callRecords,
        sourceHashes,
        checkout,
      },
      null,
      2,
    );
    await NodeFSP.writeFile(builderReceipt, receipt);
    throw new Error(
      `${failed.command} ${failed.args.join(" ")} exited ${failed.exitCode}: ${failed.stderr || failed.stdout}`,
    );
  }
  const oldPackage = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(NodePath.dirname(source), "installable-files", "t3-extension.json"),
      "utf8",
    ),
  );
  const newPackage = JSON.parse(
    await NodeFSP.readFile(NodePath.join(candidate, ".t3-extension", "t3-extension.json"), "utf8"),
  );
  NodeAssert.deepEqual(
    { ...newPackage.manifest, version: oldPackage.manifest.version },
    oldPackage.manifest,
  );
  NodeAssert.deepEqual(newPackage.provides, oldPackage.provides);
  NodeAssert.deepEqual(newPackage.requires, oldPackage.requires);
  const receipt = JSON.stringify(
    {
      kind: "typed-files-builder",
      candidate,
      sdkTarball,
      calls: calls.map(({ stdout, stderr, ...call }) => ({ ...call, stdout, stderr })),
      sourceHashes,
      checkout,
    },
    null,
    2,
  );
  await NodeFSP.writeFile(builderReceipt, receipt);
  await NodeFSP.writeFile(NodePath.join(root, "candidate-path.txt"), candidate + "\n");
  console.log("Typed Files proof: " + root);
  return NodePath.join(candidate, ".t3-extension", "client.mjs");
}

function makeSession() {
  const listeners = new Set();
  return {
    context: {
      client: "test",
      resource: { namespace: "example.files", id: "view", environmentId: "env" },
    },
    signal: new AbortController().signal,
    visible: true,
    restoreState: null,
    onVisibility(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save() {
      return true;
    },
    listeners,
  };
}

function makeHost(session, pending) {
  return {
    React,
    invokeApi(request, signal) {
      return new Promise((resolve, reject) => pending.push({ request, signal, resolve, reject }));
    },
    subscribeApi() {
      throw new Error("not used");
    },
    discoverApis() {
      return Promise.resolve([]);
    },
    invokeTool() {
      throw new Error("not used");
    },
    session,
  };
}

async function exercise(createClient) {
  const pending = [],
    session = makeSession(),
    host = makeHost(session, pending);
  const extension = createClient(host);
  const Renderer = extension.surfaces[0].createView(session).renderer;
  let tree;
  await TestRenderer.act(async () => {
    tree = TestRenderer.create(React.createElement(Renderer));
  });
  NodeAssert.equal(pending[0].request.method, "listEntries");
  await TestRenderer.act(async () => {
    pending.shift().resolve({
      entries: [
        { name: "src", relativePath: "src", kind: "directory" },
        { name: "a.txt", relativePath: "a.txt", kind: "file" },
      ],
      nextCursor: "page-2",
    });
  });
  const buttons = () => tree.root.findAllByType("button");
  await TestRenderer.act(async () => {
    buttons()
      .find((button) => button.props.children === "Load more entries")
      .props.onClick();
  });
  const pageRequest = pending.find(
    (item) => item.request.method === "listEntries" && item.request.input.cursor === "page-2",
  );
  NodeAssert.ok(pageRequest);
  await TestRenderer.act(async () => {
    buttons()
      .find((button) => button.props.children === "src/")
      .props.onClick();
  });
  NodeAssert.equal(pageRequest.signal.aborted, true);
  const directoryRequest = pending.find(
    (item) => item.request.method === "listEntries" && item.request.input.relativePath === "src",
  );
  NodeAssert.ok(directoryRequest);
  await TestRenderer.act(async () => {
    directoryRequest.resolve({
      entries: [
        { name: "a.txt", relativePath: "src/a.txt", kind: "file" },
        { name: "b.txt", relativePath: "src/b.txt", kind: "file" },
      ],
      nextCursor: null,
    });
  });
  await TestRenderer.act(async () => {
    pageRequest.resolve({
      entries: [{ name: "late.txt", relativePath: "late.txt", kind: "file" }],
      nextCursor: null,
    });
  });
  NodeAssert.equal(buttons().filter((button) => button.props.title === "late.txt").length, 0);
  const fileButton = buttons().find((button) => button.props.children === "a.txt");
  await TestRenderer.act(async () => fileButton.props.onClick());
  const readRequest = pending.find((item) => item.request.method === "readText");
  NodeAssert.deepEqual(readRequest.request.input, { relativePath: "src/a.txt" });
  await TestRenderer.act(async () =>
    buttons()
      .find((button) => button.props.children === "b.txt")
      .props.onClick(),
  );
  const newerRead = pending.find(
    (item) => item.request.method === "readText" && item !== readRequest,
  );
  NodeAssert.ok(newerRead);
  NodeAssert.equal(readRequest.signal.aborted, true);
  await TestRenderer.act(async () => {
    newerRead.resolve({
      relativePath: "b.txt",
      contents: "fresh",
      byteLength: 5,
      truncated: false,
    });
  });
  NodeAssert.equal(
    tree.root.findByProps({ "aria-label": "File contents" }).children.join(""),
    "fresh",
  );
  await TestRenderer.act(async () => {
    readRequest.resolve({
      relativePath: "a.txt",
      contents: "stale",
      byteLength: 5,
      truncated: false,
    });
  });
  NodeAssert.equal(
    tree.root.findByProps({ "aria-label": "File contents" }).children.join(""),
    "fresh",
  );
  NodeAssert.equal(
    tree.root.findByProps({ "aria-label": "File contents" }).children.join("").includes("stale"),
    false,
  );
  await TestRenderer.act(async () => {
    buttons()
      .find((button) => button.props.children === "Parent directory")
      .props.onClick();
  });
  const parentRequest = pending.find(
    (item) => item.request.method === "listEntries" && item.request.input.relativePath === "",
  );
  NodeAssert.ok(parentRequest);
  await TestRenderer.act(async () => {
    parentRequest.resolve({
      entries: [{ name: "a.txt", relativePath: "a.txt", kind: "file" }],
      nextCursor: null,
    });
  });
  await TestRenderer.act(async () => tree.unmount());
  return pending.map(({ request }) => ({ method: request.method, input: request.input }));
}

NodeTest.test(
  "typed Files candidate builds externally and matches baseline requests with stale isolation",
  async () => {
    const builtClient = await buildCandidate();
    const createCandidate = (await import(NodeURL.pathToFileURL(builtClient))).default;
    const baselineRequests = await exercise(createBaseline);
    const candidateRequests = await exercise(createCandidate);
    NodeAssert.deepEqual(candidateRequests, baselineRequests);
    const proofReceipt = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(
          NodePath.dirname(NodePath.dirname(NodePath.dirname(builtClient))),
          "receipts.json",
        ),
        "utf8",
      ),
    );
    NodeAssert.match(
      proofReceipt.checkout.commit,
      /^[0-9a-f]{40}$/,
      "proof receipt does not pin the checkout commit",
    );
    NodeAssert.equal(typeof proofReceipt.checkout.dirty, "boolean");
  },
);

import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import React from "react";
import { act, create } from "react-test-renderer";
import { validateEnvironmentPackage, validateServerExtension } from "../dist/environment.js";
import {
  validateWorkspaceReadTextInput,
  validateWorkspaceReadTextResult,
  WORKSPACE_READ_TEXT,
} from "../dist/workspace.js";
import { createExtensionHost } from "../dist/host.js";
import { ExtensionSurface } from "../dist/react.js";
import createReader from "../examples/installable-workspace-reader/client.mjs";
import server from "../examples/installable-workspace-reader/server.mjs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const descriptor = JSON.parse(
  await NodeFSP.readFile(
    new URL("../examples/installable-workspace-reader/t3-extension.json", import.meta.url),
    "utf8",
  ),
);
const streamDescriptor = JSON.parse(
  await NodeFSP.readFile(
    new URL("../examples/installable-stream-provider/t3-extension.json", import.meta.url),
    "utf8",
  ),
);
const streamServer = (await import("../examples/installable-stream-provider/server.mjs")).default;
const context = {
  resource: {
    namespace: "example.workspace",
    id: "reader",
    environmentId: "env",
    projectId: "project",
  },
  client: "web",
};
NodeTest.test(
  "package and public workspace contracts reject malformed paths, schemas and handlers",
  () => {
    NodeAssert.deepEqual(validateEnvironmentPackage(descriptor), descriptor);
    NodeAssert.equal(validateServerExtension(descriptor, server).tools.length, 1);
    for (const clientEntry of [
      "/client.mjs",
      "../client.mjs",
      "a/../client.mjs",
      "a\\client.mjs",
      "https://host/client.mjs",
      "client.mjs?x",
      "./client.mjs",
      "client.ts",
      "",
    ])
      NodeAssert.throws(() => validateEnvironmentPackage({ ...descriptor, clientEntry }));
    NodeAssert.throws(() => validateEnvironmentPackage({ ...descriptor, serverEntry: undefined }));
    NodeAssert.throws(() => validateEnvironmentPackage({ ...descriptor, grants: ["all"] }));
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...descriptor,
        tools: [{ ...descriptor.tools[0], readOnly: false }],
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...descriptor,
        tools: [{ ...descriptor.tools[0], inputSchema: { $ref: "https://remote/schema" } }],
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...descriptor,
        tools: [...descriptor.tools, ...descriptor.tools],
      }),
    );
    NodeAssert.throws(() => validateServerExtension(descriptor, { tools: [] }));
    NodeAssert.throws(() =>
      validateServerExtension(descriptor, {
        tools: [{ id: descriptor.tools[0].id, invoke: "not a function" }],
      }),
    );
    for (const relativePath of [
      "../secret",
      "/secret",
      "C:/secret",
      "a\\b",
      "a//b",
      "a/./b",
      " x",
      "x\n",
    ])
      NodeAssert.throws(() => validateWorkspaceReadTextInput({ relativePath }));
    NodeAssert.deepEqual(validateWorkspaceReadTextInput({ relativePath: "src/file.txt" }), {
      relativePath: "src/file.txt",
    });
    NodeAssert.throws(() =>
      validateWorkspaceReadTextResult({
        relativePath: "file",
        contents: "🌈".repeat(17000),
        byteLength: 68000,
        truncated: false,
      }),
    );
  },
);
NodeTest.test(
  "bundled reader uses injected React, real fixture read, explicit context and restore without reread",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-package-reader-"));
    const content = "Actual fixture text 選択 🌈";
    await NodeFSP.writeFile(NodePath.join(directory, "README.md"), content);
    const calls = [];
    const extension = createReader({
      React,
      async invokeTool(id, input, currentContext, signal) {
        NodeAssert.equal(id, descriptor.tools[0].id);
        return server.tools[0].invoke(input, {
          context: currentContext,
          signal,
          async invoke(capability, request) {
            NodeAssert.equal(capability, WORKSPACE_READ_TEXT);
            const { relativePath } = validateWorkspaceReadTextInput(request);
            calls.push([currentContext.resource.environmentId, relativePath]);
            const contents = await NodeFSP.readFile(NodePath.join(directory, relativePath), "utf8");
            return validateWorkspaceReadTextResult({
              relativePath,
              contents,
              byteLength: new TextEncoder().encode(contents).length,
              truncated: false,
            });
          },
        });
      },
    });
    NodeAssert.deepEqual(extension.manifest, descriptor.manifest);
    const host = createExtensionHost({ authorize: () => false });
    host.register(extension);
    let root;
    let id;
    try {
      const record = {
        version: 1,
        surfaceId: "example.installed-reader/view",
        context,
        placement: "side-panel",
        stateVersion: 1,
        restoreState: null,
        fallback: "Reader unavailable",
      };
      id = await host.restore(record);
      await act(async () => {
        root = create(React.createElement(ExtensionSurface, { host, viewId: id }));
      });
      NodeAssert.equal(calls.length, 0);
      NodeAssert.throws(
        () => host.captureContext("example.installed-reader/selection", context),
        /Read a workspace/,
      );
      await act(async () => {
        await root.root.findByType("button").props.onClick();
      });
      NodeAssert.equal(root.root.findByType("pre").children.join(""), content);
      NodeAssert.equal(calls.length, 1);
      const captured = host.captureContext("example.installed-reader/selection", context);
      NodeAssert.equal(captured.text, content);
      NodeAssert.throws(
        () =>
          host.captureContext("example.installed-reader/selection", {
            ...context,
            resource: { ...context.resource, environmentId: "other" },
          }),
        /Read a workspace/,
      );
      for (const otherContext of [
        { ...context, resource: { ...context.resource, threadId: "other-thread" } },
        { ...context, workspaceRevision: "other-revision" },
      ])
        NodeAssert.throws(
          () => host.captureContext("example.installed-reader/selection", otherContext),
          /Read a workspace/,
        );
      const saved = host.records()[0];
      NodeAssert.deepEqual(saved.restoreState, { relativePath: "README.md" });
      await act(async () => {
        root.unmount();
        host.close(id);
      });
      id = await host.restore(saved);
      await act(async () => {
        root = create(React.createElement(ExtensionSurface, { host, viewId: id }));
      });
      NodeAssert.equal(calls.length, 1);
      NodeAssert.equal(root.root.findByType("input").props.value, "README.md");
    } finally {
      await act(async () => {
        root?.unmount();
        host.dispose();
      });
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
NodeTest.test("reader aborts hidden pending tool calls and refuses late presentation", async () => {
  let signal;
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const extension = createReader({
    React,
    async invokeTool(_id, _input, _context, currentSignal) {
      signal = currentSignal;
      return gate;
    },
  });
  const host = createExtensionHost({ authorize: () => false });
  host.register(extension);
  const id = await host.restore({
    version: 1,
    surfaceId: "example.installed-reader/view",
    context,
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Reader unavailable",
  });
  let root;
  try {
    await act(async () => {
      root = create(React.createElement(ExtensionSurface, { host, viewId: id }));
    });
    await act(async () => {
      root.root.findByType("button").props.onClick();
    });
    await act(async () => {
      host.hide(id);
    });
    NodeAssert.equal(signal.aborted, true);
    await act(async () => {
      finish({ relativePath: "README.md", contents: "late", byteLength: 4, truncated: false });
    });
    await act(async () => {
      await host.show(id);
    });
    NodeAssert.equal(root.root.findByType("pre").children.length, 0);
    NodeAssert.throws(
      () => host.captureContext("example.installed-reader/selection", context),
      /Read a workspace/,
    );
  } finally {
    await act(async () => {
      root?.unmount();
      host.dispose();
    });
  }
});

NodeTest.test(
  "format 4 validates strict asset declarations and legacy format 3 rejects them",
  () => {
    const package4 = {
      ...descriptor,
      format: 4,
      dependencies: [],
      provides: [],
      requires: [],
      assets: [
        {
          path: "vendor/runtime.wasm",
          byteLength: 3,
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          mediaType: "application/wasm",
        },
      ],
    };
    NodeAssert.deepEqual(validateEnvironmentPackage(package4), package4);
    NodeAssert.throws(() => validateEnvironmentPackage({ ...descriptor, format: 3, assets: [] }));
    for (const path of ["../secret", "/secret", "a\\\\b", "a//b", "a/./b", ""])
      NodeAssert.throws(() =>
        validateEnvironmentPackage({ ...package4, assets: [{ ...package4.assets[0], path }] }),
      );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...package4,
        assets: [{ ...package4.assets[0], byteLength: 4 * 1024 * 1024 + 1 }],
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...package4,
        assets: [{ ...package4.assets[0], mediaType: "text/javascript" }],
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...package4,
        assets: [package4.assets[0], { ...package4.assets[0], path: "vendor/runtime.wasm" }],
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...package4,
        assets: [package4.assets[0], { ...package4.assets[0], path: "vendor/runtime.wasm/map" }],
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...package4,
        assets: [package4.assets[0], { ...package4.assets[0], path: "client.mjs/map" }],
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...package4,
        assets: Array.from({ length: 33 }, (_, i) => ({ ...package4.assets[0], path: "x" + i })),
      }),
    );
    NodeAssert.throws(() =>
      validateEnvironmentPackage({
        ...package4,
        assets: Array.from({ length: 3 }, (_, i) => ({
          ...package4.assets[0],
          path: "x" + i,
          byteLength: 4 * 1024 * 1024,
        })),
      }),
    );
  },
);

NodeTest.test("format 4 keeps format-3 API stream declarations and exact asset boundaries", () => {
  const package4 = { ...streamDescriptor, format: 4, assets: [] };
  NodeAssert.deepEqual(validateEnvironmentPackage(package4), package4);
  NodeAssert.equal(
    validateServerExtension(package4, streamServer).apis[0].streams[0].name,
    "changes",
  );
  for (const asset of [
    { path: "a", byteLength: 0, sha256: "0".repeat(64), mediaType: "application/octet-stream" },
    {
      path: "a".repeat(240),
      byteLength: 4 * 1024 * 1024,
      sha256: "f".repeat(64),
      mediaType: "font/woff2",
    },
  ])
    NodeAssert.deepEqual(
      validateEnvironmentPackage({ ...package4, assets: [asset] }).assets[0],
      asset,
    );
  for (const asset of [
    { path: "é", byteLength: 0, sha256: "0".repeat(64), mediaType: "application/octet-stream" },
    {
      path: "a".repeat(241),
      byteLength: 0,
      sha256: "0".repeat(64),
      mediaType: "application/octet-stream",
    },
    { path: "a", byteLength: -1, sha256: "0".repeat(64), mediaType: "application/octet-stream" },
    { path: "a", byteLength: 0, sha256: "A".repeat(64), mediaType: "application/octet-stream" },
  ])
    NodeAssert.throws(() => validateEnvironmentPackage({ ...package4, assets: [asset] }));
});

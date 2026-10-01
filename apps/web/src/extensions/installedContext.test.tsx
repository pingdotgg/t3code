import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { it, expect } from "vite-plus/test";
import { createExtensionHost } from "@t3tools/extension-sdk/host";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type { ClientFactory } from "@t3tools/extension-sdk/environment";
import { installedSurfaceRecord, installedWorkspaceContext } from "./installedContext";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("ordinary Open and composer selection share server-verifiable scope in the actual bundled reader", async () => {
  const module: unknown = await import(
    /* @vite-ignore */ new URL(
      "../../../../packages/extension-sdk/examples/installable-workspace-reader/client.mjs",
      import.meta.url,
    ).href
  );
  if (
    !module ||
    typeof module !== "object" ||
    !("default" in module) ||
    typeof module.default !== "function"
  )
    throw new Error("Invalid sample factory");
  const factory = module.default as ClientFactory;
  const source = {
    environmentId: "environment-a",
    projectId: "project-a",
    threadId: "thread-a",
    projectWorkspaceRoot: "/fixture/repository",
    threadWorktreePath: "/fixture/worktrees/a",
    client: "web",
  };
  const extension = factory({
    React,
    subscribeApi: () => ({ async *[Symbol.asyncIterator]() {} }),
    invokeApi: async () => {
      throw new Error("Unused API call");
    },
    discoverApis: async () => [],
    invokeTool: async (_tool, _input, context) => {
      expect(context.workspaceRevision).toBe(
        JSON.stringify([source.projectWorkspaceRoot, source.threadWorktreePath]),
      );
      expect(context.resource.threadId).toBe(source.threadId);
      return {
        relativePath: "README.md",
        contents: "Actual sample fixture selection",
        byteLength: 31,
        truncated: false,
      };
    },
  });
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => false });
  host.register(extension);
  const record = installedSurfaceRecord(
    extension.manifest.id,
    extension.manifest.surfaces[0]!,
    "side-panel",
    installedWorkspaceContext(source),
  );
  const id = await host.restore(record);
  let root!: ReactTestRenderer;
  try {
    await act(async () => {
      root = create(<ExtensionSurface host={host} viewId={id} />);
    });
    await act(async () => {
      await root.root.findByType("button").props.onClick();
    });
    const composerContext = installedWorkspaceContext(source);
    expect(host.captureContext("example.installed-reader/selection", composerContext).text).toBe(
      "Actual sample fixture selection",
    );
    expect(() =>
      host.captureContext(
        "example.installed-reader/selection",
        installedWorkspaceContext({ ...source, threadWorktreePath: null }),
      ),
    ).toThrow("Read a workspace");
    expect(
      installedWorkspaceContext({ ...source, threadWorktreePath: source.projectWorkspaceRoot })
        .workspaceRevision,
    ).not.toBe(
      installedWorkspaceContext({ ...source, threadWorktreePath: null }).workspaceRevision,
    );
  } finally {
    await act(async () => {
      root?.unmount();
      host.dispose();
    });
  }
});

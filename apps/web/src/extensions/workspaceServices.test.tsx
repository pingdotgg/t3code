import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { workspaceReader } from "../../../../packages/extension-sdk/examples/workspace-reader/workspace-reader.mjs";
import { registerWorkspaceExtension, WorkspaceExtensionSurface } from "./workspaceRegistry";
import { workspaceReadHostOptions } from "./services/workspaceRead";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const record: ViewRecord = {
  version: 1,
  surfaceId: "example.workspace-reader/view",
  placement: "side-panel",
  stateVersion: 1,
  restoreState: { relativePath: "notes.txt" },
  fallback: "Workspace reader unavailable",
  context: {
    client: "web",
    resource: {
      namespace: "example.workspace",
      id: "reader",
      environmentId: "env",
      projectId: "project",
    },
  },
};
describe("community reader through application service bootstrap", () => {
  it("defaults to denied restoration without changing native bridge defaults", async () => {
    const unregister = registerWorkspaceExtension(workspaceReader);
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<WorkspaceExtensionSurface record={record} visible />);
      });
      expect(root.root.findAllByType("button")).toHaveLength(0);
      expect(root.root.findByProps({ role: "status" }).children.join("")).toMatch(
        /capability|permission|grant|denied|unavailable/i,
      );
    } finally {
      await act(async () => {
        root?.unmount();
        unregister();
      });
    }
  });
  it("reads through installed service, saves without publish, restores and revokes", async () => {
    let enabled = true;
    const inputs: unknown[] = [];
    const saved: ViewRecord[] = [];
    const options = workspaceReadHostOptions(
      {
        resolve: () => ({ cwd: "/fixture", revision: "v1" }),
        read: async (environmentId, input) => {
          inputs.push({ environmentId, input });
          return {
            relativePath: input.relativePath,
            contents: "real adapter result",
            byteLength: 19,
            truncated: false,
          };
        },
      },
      {
        extensionId: workspaceReader.manifest.id,
        environmentId: "env",
        projectId: "project",
        isEnabled: () => enabled,
      },
    );
    const unregister = registerWorkspaceExtension(workspaceReader, options);
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <WorkspaceExtensionSurface
            record={record}
            visible
            onRecordChange={(value) => saved.push(value)}
          />,
        );
      });
      expect(inputs).toEqual([]);
      expect(root.root.findByType("input").props.value).toBe("notes.txt");
      await act(async () => {
        root.root.findByType("input").props.onChange({ target: { value: "README.md" } });
      });
      await act(async () => {
        root.root.findByType("button").props.onClick();
      });
      expect(inputs).toEqual([
        { environmentId: "env", input: { cwd: "/fixture", relativePath: "README.md" } },
      ]);
      expect(root.root.findByType("pre").children).toEqual(["real adapter result"]);
      expect(saved.at(-1)?.restoreState).toEqual({ relativePath: "README.md" });
      const renderer = root.root.findByType("input");
      await act(async () => {
        root.update(<WorkspaceExtensionSurface record={record} visible={false} />);
      });
      await act(async () => {
        root.update(<WorkspaceExtensionSurface record={record} visible />);
      });
      expect(root.root.findByType("input")).toBe(renderer);
      enabled = false;
      await act(async () => {
        root.root.findByType("button").props.onClick();
      });
      expect(inputs).toHaveLength(1);
      expect(root.root.findByProps({ role: "status" }).children.join("")).not.toBe("Read complete");
      enabled = true;
      await act(async () => {
        root.unmount();
      });
      await act(async () => {
        root = create(<WorkspaceExtensionSurface record={saved.at(-1)!} visible />);
      });
      expect(root.root.findByType("input").props.value).toBe("README.md");
      expect(inputs).toHaveLength(1);
    } finally {
      await act(async () => {
        root?.unmount();
        unregister();
      });
    }
  });
  it("does not render late read content after hide or unregister", async () => {
    let resolve!: (value: {
      relativePath: string;
      contents: string;
      byteLength: number;
      truncated: boolean;
    }) => void;
    const pending = new Promise<{
      relativePath: string;
      contents: string;
      byteLength: number;
      truncated: boolean;
    }>((done) => {
      resolve = done;
    });
    const unregister = registerWorkspaceExtension(
      workspaceReader,
      workspaceReadHostOptions(
        {
          resolve: () => ({ cwd: "/fixture", revision: "v1" }),
          read: () => pending,
        },
        {
          extensionId: workspaceReader.manifest.id,
          environmentId: "env",
          projectId: "project",
          isEnabled: () => true,
        },
      ),
    );
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<WorkspaceExtensionSurface record={record} visible />);
      });
      await act(async () => {
        root.root.findByType("button").props.onClick();
      });
      await act(async () => {
        root.update(<WorkspaceExtensionSurface record={record} visible={false} />);
      });
      await act(async () => {
        resolve({ relativePath: "notes.txt", contents: "late", byteLength: 4, truncated: false });
      });
      await act(async () => {
        root.update(<WorkspaceExtensionSurface record={record} visible />);
      });
      expect(root.root.findByType("pre").children).toEqual([]);
      await act(async () => {
        unregister();
      });
      expect(root.root.findByProps({ role: "status" }).children).toEqual([record.fallback]);
    } finally {
      await act(async () => {
        root?.unmount();
        unregister();
      });
    }
  });
});

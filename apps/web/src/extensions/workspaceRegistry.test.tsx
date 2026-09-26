import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";
import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import {
  decorateWorkspaceMessage,
  useWorkspaceTextRevision,
  captureWorkspaceContext,
  registerWorkspaceExtension,
  useWorkspaceSurfaceTitles,
  WorkspaceExtensionSurface,
} from "./workspaceRegistry";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("workspace extension registration", () => {
  it("updates mounted tab text and close labels when registration changes", async () => {
    const extension: Extension<SurfaceRenderer> = {
      manifest: {
        id: "community.metadata",
        version: "1.0.0",
        apiVersion: 1,
        surfaces: [
          {
            id: "community.metadata/view",
            title: "Metadata",
            scope: "project",
            clients: ["web"],
            placements: ["side-panel"],
            capabilities: [],
            stateVersion: 1,
          },
        ],
      },
      surfaces: [
        {
          id: "community.metadata/view",
          validateRestore: (state) => state === null,
          createView: () => ({ renderer: () => <span>Metadata body</span> }),
        },
      ],
    };
    function TabMetadata() {
      const titles = useWorkspaceSurfaceTitles();
      const title = titles.get("community.metadata/view") ?? "Install metadata";
      return <button aria-label={`Close ${title}`}>{title}</button>;
    }
    let root!: ReactTestRenderer;
    let unregister = () => {};
    try {
      await act(async () => {
        root = create(<TabMetadata />);
      });
      expect(root.root.findByType("button").children).toEqual(["Install metadata"]);
      expect(root.root.findByType("button").props["aria-label"]).toBe("Close Install metadata");
      await act(async () => {
        unregister = registerWorkspaceExtension(extension);
      });
      expect(root.root.findByType("button").children).toEqual(["Metadata"]);
      expect(root.root.findByType("button").props["aria-label"]).toBe("Close Metadata");
      await act(async () => {
        unregister();
      });
      expect(root.root.findByType("button").children).toEqual(["Install metadata"]);
      expect(root.root.findByType("button").props["aria-label"]).toBe("Close Install metadata");
    } finally {
      await act(async () => {
        root?.unmount();
        unregister();
      });
    }
  });
  it("opens an independent contribution, contains disable, and restores its retained record", async () => {
    let disposed = 0;
    const extension: Extension<SurfaceRenderer> = {
      manifest: {
        id: "community.sample",
        version: "1.0.0",
        apiVersion: 1,
        surfaces: [
          {
            id: "community.sample/view",
            title: "Sample",
            scope: "project",
            clients: ["web"],
            placements: ["side-panel"],
            capabilities: [],
            stateVersion: 1,
          },
        ],
      },
      surfaces: [
        {
          id: "community.sample/view",
          validateRestore: (state) => state === null,
          createView: () => ({
            renderer: () => <button>Independent sample</button>,
            dispose: () => {
              disposed++;
            },
          }),
        },
      ],
    };
    const record: ViewRecord = {
      version: 1,
      surfaceId: "community.sample/view",
      placement: "side-panel",
      stateVersion: 1,
      restoreState: null,
      fallback: "Install Sample to restore this view",
      context: {
        client: "web",
        resource: {
          namespace: "community.resource",
          id: "sample",
          environmentId: "env",
          projectId: "project",
        },
      },
    };
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<WorkspaceExtensionSurface record={record} visible />);
    });
    expect(root.root.findByProps({ role: "status" }).children).toEqual([record.fallback]);
    let unregister!: () => void;
    await act(async () => {
      unregister = registerWorkspaceExtension(extension);
    });
    expect(root.root.findByType("button").children).toEqual(["Independent sample"]);
    expect(() => registerWorkspaceExtension(extension)).toThrow("already registered");
    await act(async () => {
      unregister();
      unregister();
    });
    expect(disposed).toBe(1);
    expect(root.root.findByProps({ role: "status" }).children).toEqual([record.fallback]);
    await act(async () => {
      unregister = registerWorkspaceExtension(extension);
    });
    expect(root.root.findByType("button").children).toEqual(["Independent sample"]);
    await act(async () => {
      root.unmount();
      unregister();
    });
    expect(disposed).toBe(2);
  });
});

it("routes identical installed IDs by environment and keeps other environments live on unload", async () => {
  function extension(label: string): Extension<SurfaceRenderer> {
    return {
      manifest: {
        id: "installed.scoped",
        version: "1.0.0",
        apiVersion: 1,
        surfaces: [
          {
            id: "installed.scoped/view",
            title: label,
            scope: "project",
            clients: ["web"],
            placements: ["side-panel"],
            capabilities: [],
            stateVersion: 1,
          },
        ],
        composerContexts: [{ id: "installed.scoped/context", title: label, clients: ["web"] }],
      },
      surfaces: [
        {
          id: "installed.scoped/view",
          validateRestore: (state) => state === null,
          createView: () => ({ renderer: () => <span>{label}</span> }),
        },
      ],
      composerContexts: [
        { id: "installed.scoped/context", select: () => ({ title: label, text: label }) },
      ],
    };
  }
  const context = (environmentId: string) => ({
    client: "web",
    resource: { namespace: "installed.scoped", id: "view", environmentId, projectId: "project" },
  });
  const record = (environmentId: string): ViewRecord => ({
    version: 1,
    surfaceId: "installed.scoped/view",
    context: context(environmentId),
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Unavailable " + environmentId,
  });
  let root!: ReactTestRenderer;
  let stopA = () => {};
  let stopB = () => {};
  try {
    await act(async () => {
      stopA = registerWorkspaceExtension(extension("Environment A"), undefined, {
        environmentId: "env-a",
      });
      stopB = registerWorkspaceExtension(extension("Environment B"), undefined, {
        environmentId: "env-b",
      });
      root = create(
        <>
          <WorkspaceExtensionSurface record={record("env-a")} visible />
          <WorkspaceExtensionSurface record={record("env-b")} visible />
        </>,
      );
    });
    expect(root.root.findAllByType("span").map((node) => node.children.join(""))).toEqual([
      "Environment A",
      "Environment B",
    ]);
    expect(captureWorkspaceContext("installed.scoped/context", context("env-b")).text).toBe(
      "Environment B",
    );
    expect(() => captureWorkspaceContext("installed.scoped/context", context("env-c"))).toThrow(
      "unavailable",
    );
    await act(async () => stopA());
    expect(root.root.findAllByType("span").map((node) => node.children.join(""))).toEqual([
      "Environment B",
    ]);
    expect(JSON.stringify(root.toJSON())).toContain("Unavailable env-a");
  } finally {
    await act(async () => {
      root?.unmount();
      stopA();
      stopB();
    });
  }
});

it("an environment version shadows the entire global package, including removed contributions", async () => {
  let oldCalls = 0;
  let newCalls = 0;
  let revision = 0;
  const old: Extension<SurfaceRenderer> = {
    manifest: {
      id: "shadow.package",
      version: "1.0.0",
      apiVersion: 1,
      surfaces: [
        {
          id: "shadow.package/old",
          title: "Old",
          scope: "project",
          clients: ["web"],
          placements: ["side-panel"],
          capabilities: [],
          stateVersion: 1,
        },
      ],
      messageDecorations: [{ id: "shadow.package/card", title: "Card", clients: ["web"] }],
    },
    surfaces: [
      {
        id: "shadow.package/old",
        validateRestore: (state) => state === null,
        createView: () => ({ renderer: () => <span>Old surface</span> }),
      },
    ],
    messageDecorations: [
      {
        id: "shadow.package/card",
        decorate: () => {
          oldCalls++;
          return { title: "Old", text: "Old" };
        },
      },
    ],
  };
  const next: Extension<SurfaceRenderer> = {
    manifest: { ...old.manifest, version: "2.0.0", surfaces: [] },
    surfaces: [],
    messageDecorations: [
      {
        id: "shadow.package/card",
        decorate: () => {
          newCalls++;
          return { title: "New", text: "New" };
        },
      },
    ],
  };
  function Revision() {
    revision = useWorkspaceTextRevision();
    return null;
  }
  const context = {
    client: "web",
    resource: {
      namespace: "shadow.package",
      id: "old",
      environmentId: "env-a",
      projectId: "project",
    },
  };
  const record: ViewRecord = {
    version: 1,
    surfaceId: "shadow.package/old",
    context,
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Removed surface unavailable",
  };
  let root!: ReactTestRenderer;
  let stopGlobal = () => {};
  let stopEnvironment = () => {};
  try {
    await act(async () => {
      stopGlobal = registerWorkspaceExtension(old);
      stopEnvironment = registerWorkspaceExtension(next, undefined, { environmentId: "env-a" });
      root = create(
        <>
          <Revision />
          <WorkspaceExtensionSurface record={record} visible />
        </>,
      );
    });
    expect(JSON.stringify(root.toJSON())).toContain("Removed surface unavailable");
    expect(
      decorateWorkspaceMessage(
        { environmentId: "env-a", threadId: "thread", messageId: "message", text: "Text" },
        "web",
        revision,
      ).map((card) => card.title),
    ).toEqual(["New"]);
    expect(newCalls).toBe(1);
    expect(oldCalls).toBe(0);
    expect(
      decorateWorkspaceMessage(
        { environmentId: "env-b", threadId: "thread", messageId: "message", text: "Text" },
        "web",
        revision,
      ).map((card) => card.title),
    ).toEqual(["Old"]);
    expect(oldCalls).toBe(1);
  } finally {
    await act(async () => {
      root?.unmount();
      stopEnvironment();
      stopGlobal();
    });
  }
});

it("marks a declared terminal-focus surface's frame as extension-owned", async () => {
  const makeExtension = (claimsTerminalFocus: boolean): Extension<SurfaceRenderer> => ({
    manifest: {
      id: "community.focus",
      version: "1.0.0",
      apiVersion: 1,
      surfaces: [
        {
          id: "community.focus/view",
          title: "Focus",
          scope: "project",
          clients: ["web"],
          placements: ["side-panel"],
          capabilities: [],
          ...(claimsTerminalFocus ? { claimsTerminalFocus: true } : {}),
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: "community.focus/view",
        validateRestore: (state) => state === null,
        createView: () => ({ renderer: () => <input aria-label="Focus target" /> }),
      },
    ],
  });
  const record: ViewRecord = {
    version: 1,
    surfaceId: "community.focus/view",
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Focus view unavailable",
    context: {
      client: "web",
      resource: {
        namespace: "community.focus",
        id: "view",
        environmentId: "env",
        projectId: "project",
      },
    },
  };
  let root!: ReactTestRenderer;
  let stop = () => {};
  try {
    await act(async () => {
      stop = registerWorkspaceExtension(makeExtension(true));
      root = create(<WorkspaceExtensionSurface record={record} visible />);
    });
    const tagged = root.root.findAllByProps({ "data-terminal-owner": "extension" });
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.findByProps({ "aria-label": "Focus target" })).toBeTruthy();
    await act(async () => {
      stop();
      stop = registerWorkspaceExtension(makeExtension(false));
    });
    expect(root.root.findAllByProps({ "data-terminal-owner": "extension" })).toHaveLength(0);
  } finally {
    await act(async () => {
      root?.unmount();
      stop();
    });
  }
});

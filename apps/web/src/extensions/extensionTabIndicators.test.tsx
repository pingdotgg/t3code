import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it } from "vite-plus/test";
import type { Extension, ViewSession } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import {
  extensionTabKey,
  setExtensionTabIndicators,
  useExtensionTabIndicators,
} from "./extensionTabIndicators";
import { registerWorkspaceExtension, WorkspaceExtensionSurface } from "./workspaceRegistry";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const record: ViewRecord = {
  version: 1,
  surfaceId: "community.pages/view",
  placement: "side-panel",
  stateVersion: 1,
  restoreState: null,
  fallback: "Install Pages",
  context: {
    client: "web",
    resource: { namespace: "community.pages", id: "pages", environmentId: "env", projectId: "p" },
  },
};

it("carries a view's tab indicators to the tab strip, through hiding, until unmount", async () => {
  let session!: ViewSession;
  const extension: Extension<SurfaceRenderer> = {
    manifest: {
      id: "community.pages",
      version: "1.0.0",
      apiVersion: 1,
      surfaces: [
        {
          id: "community.pages/view",
          title: "Pages",
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
        id: "community.pages/view",
        validateRestore: (state) => state === null,
        createView: (created) => {
          session = created;
          return { renderer: () => <span>Pages body</span> };
        },
      },
    ],
  };
  function Tab() {
    const indicators = useExtensionTabIndicators(extensionTabKey(record));
    return <output>{JSON.stringify(indicators)}</output>;
  }
  const tabText = () => root.root.findByType("output").children.join("");
  let root!: ReactTestRenderer;
  const unregister = registerWorkspaceExtension(extension);
  try {
    await act(async () => {
      root = create(
        <>
          <Tab />
          <WorkspaceExtensionSurface record={record} visible />
        </>,
      );
    });
    expect(tabText()).toBe("null");
    await act(async () => {
      session.setTabIndicators({ pageUrl: "https://example.com/", audio: "audible" });
    });
    expect(JSON.parse(tabText())).toEqual({ pageUrl: "https://example.com/", audio: "audible" });
    // A hidden (background) tab keeps updating its indicators.
    await act(async () => {
      root.update(
        <>
          <Tab />
          <WorkspaceExtensionSurface record={record} visible={false} />
        </>,
      );
    });
    await act(async () => {
      session.setTabIndicators({ pageUrl: "https://example.com/", audio: "muted" });
    });
    expect(JSON.parse(tabText())).toEqual({ pageUrl: "https://example.com/", audio: "muted" });
    // Closing the view removes its chrome.
    await act(async () => {
      root.update(<Tab />);
    });
    expect(tabText()).toBe("null");
  } finally {
    await act(async () => {
      root?.unmount();
      unregister();
    });
  }
});

it("republishes a badge only when its kind or count changes", async () => {
  const key = "badge.test/view\nkey";
  let renders = 0;
  function Tab() {
    const indicators = useExtensionTabIndicators(key);
    useEffect(() => {
      renders += 1;
    });
    return <output>{JSON.stringify(indicators?.badge ?? null)}</output>;
  }
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Tab />);
  });
  const text = () => root.root.findByType("output").children.join("");
  try {
    await act(async () => {
      setExtensionTabIndicators(key, { badge: { kind: "running", count: 2 } });
    });
    expect(JSON.parse(text())).toEqual({ kind: "running", count: 2 });
    const settled = renders;
    // An identical event-driven republish is not a render.
    await act(async () => {
      setExtensionTabIndicators(key, { badge: { kind: "running", count: 2 } });
    });
    expect(renders).toBe(settled);
    await act(async () => {
      setExtensionTabIndicators(key, { badge: { kind: "running", count: 3 } });
    });
    expect(JSON.parse(text())).toEqual({ kind: "running", count: 3 });
    await act(async () => {
      setExtensionTabIndicators(key, { badge: { kind: "unread", count: 3 } });
    });
    expect(JSON.parse(text())).toEqual({ kind: "unread", count: 3 });
    await act(async () => {
      setExtensionTabIndicators(key, {});
    });
    expect(text()).toBe("null");
  } finally {
    await act(async () => {
      setExtensionTabIndicators(key, null);
      root.unmount();
    });
  }
});

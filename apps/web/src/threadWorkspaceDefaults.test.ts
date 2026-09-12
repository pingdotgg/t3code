import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, test } from "vite-plus/test";

import { initializeNewThreadWorkspace } from "./initializeThreadWorkspace";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";
import { getPanes } from "./splitPaneTree";
import {
  parsePersistedThreadWorkspaceDefaults,
  selectThreadWorkspaceDefault,
  useThreadWorkspaceDefaultStore,
} from "./threadWorkspaceDefaultStore";
import {
  createThreadWorkspaceDefault,
  parseThreadWorkspaceDefault,
  threadWorkspaceDefaultHasChanges,
} from "./threadWorkspaceDefaults";
import {
  selectThreadWorkspaceLayout,
  useThreadWorkspaceLayoutStore,
} from "./threadWorkspaceLayoutStore";
import {
  createThreadWorkspaceTabFields,
  transitionThreadWorkspaceTabs,
} from "./threadWorkspaceTabs";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("env-test"), ThreadId.make("thread-test"));
const PROJECT_KEY = "project:test";

function templateWithSurface(surfaceId: "files" | "diff") {
  return createThreadWorkspaceDefault(createThreadWorkspaceTabFields([surfaceId]), {
    isOpen: true,
    activeSurfaceId: surfaceId,
    surfaces: [
      surfaceId === "files" ? { id: "files", kind: "files" } : { id: "diff", kind: "diff" },
    ],
  });
}

beforeEach(() => {
  useThreadWorkspaceLayoutStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useThreadWorkspaceDefaultStore.setState({ globalDefault: null, byProjectKey: {} });
});

describe("thread workspace defaults", () => {
  test("keeps an unopened browser default through session reconciliation", () => {
    const layout = transitionThreadWorkspaceTabs(
      createThreadWorkspaceTabFields(["browser:original"]),
      {
        _tag: "SplitTab",
        paneId: "pane:root",
        tabId: "pane-tab:1",
        direction: "right",
        mode: "move",
      },
    );
    const template = createThreadWorkspaceDefault(layout, {
      isOpen: true,
      activeSurfaceId: "browser:original",
      surfaces: [{ id: "browser:original", kind: "preview", resourceId: "original" }],
    });
    useThreadWorkspaceDefaultStore.getState().saveGlobal(template);
    initializeNewThreadWorkspace(THREAD_REF, PROJECT_KEY);
    useRightPanelStore.getState().reconcileBrowserSurfaces(THREAD_REF, []);
    const surfaces = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      THREAD_REF,
    ).surfaces;
    const restored = useThreadWorkspaceLayoutStore.getState().transition(THREAD_REF, {
      _tag: "ReconcileSurfaceTabs",
      surfaceIds: surfaces.map((surface) => surface.id),
    });

    expect(surfaces).toEqual([{ id: "browser:new", kind: "preview", resourceId: null }]);
    expect(restored).toEqual(template.layout);
    expect(getPanes(restored.paneTree.root)).toHaveLength(2);
  });

  test("captures reusable tools while replacing runtime-bound resources", () => {
    let layout = createThreadWorkspaceTabFields([
      "files",
      "file:README.md",
      "browser:runtime-tab",
      "terminal:runtime-terminal",
    ]);
    layout = transitionThreadWorkspaceTabs(layout, {
      _tag: "SplitTab",
      paneId: "pane:root",
      tabId: "pane-tab:4",
      direction: "right",
      mode: "move",
    });

    const template = createThreadWorkspaceDefault(layout, {
      isOpen: true,
      activeSurfaceId: "terminal:runtime-terminal",
      surfaces: [
        { id: "files", kind: "files" },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 0,
        },
        { id: "browser:runtime-tab", kind: "preview", resourceId: "runtime-tab" },
        {
          id: "terminal:runtime-terminal",
          kind: "terminal",
          resourceId: "runtime-terminal",
          terminalIds: ["runtime-terminal", "runtime-terminal-2"],
          activeTerminalId: "runtime-terminal-2",
          splitDirection: "vertical",
        },
      ],
    });

    expect(template.rightPanel.surfaces).toEqual([
      { id: "files", kind: "files" },
      { id: "files:2", kind: "files" },
      { id: "browser:new", kind: "preview", resourceId: null },
      {
        id: "terminal:workspace-1",
        kind: "terminal",
        resourceId: "workspace-1",
        terminalIds: ["workspace-1", "workspace-1-2"],
        activeTerminalId: "workspace-1-2",
        splitDirection: "vertical",
      },
    ]);
    expect(Object.values(template.layout.tabsById)).not.toContainEqual(
      expect.objectContaining({ surfaceId: "file:README.md" }),
    );
    expect(Object.values(template.layout.tabsById)).toContainEqual(
      expect.objectContaining({ surfaceId: "files:2" }),
    );
    expect(Object.values(template.layout.tabsById)).toContainEqual(
      expect.objectContaining({ surfaceId: "browser:new" }),
    );
    expect(getPanes(template.layout.paneTree.root)).toHaveLength(2);
    expect(template.layout.paneTree.maximizedPaneId).toBeNull();
  });

  test("keeps resource-bound tabs as reusable tool tabs", () => {
    const pullRequestId = "pull-request:github.com:owner/repo:42";
    const deviceId = "device:simulator";
    const template = createThreadWorkspaceDefault(
      createThreadWorkspaceTabFields([pullRequestId, deviceId]),
      {
        isOpen: true,
        activeSurfaceId: pullRequestId,
        surfaces: [
          {
            id: pullRequestId,
            kind: "pull-request",
            projectId: "project-test",
            host: "github.com",
            repository: "owner/repo",
            number: 42,
            url: "https://github.com/owner/repo/pull/42",
          },
          {
            id: deviceId,
            kind: "device",
            target: {
              hostId: "host-test",
              deviceId: "simulator",
              platform: "ios",
              name: "iPhone",
            },
          },
        ],
      },
    );

    expect(template.rightPanel).toMatchObject({
      activeSurfaceId: "pull-requests",
      surfaces: [
        { id: "pull-requests", kind: "pull-requests" },
        { id: "device", kind: "device" },
      ],
    });
    expect(Object.values(template.layout.tabsById)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surfaceId: "pull-requests" }),
        expect.objectContaining({ surfaceId: "device" }),
      ]),
    );
  });

  test("project defaults override the global default", () => {
    const globalDefault = templateWithSurface("files");
    const projectDefault = templateWithSurface("diff");
    const state = {
      globalDefault,
      byProjectKey: { [PROJECT_KEY]: projectDefault },
    };

    expect(selectThreadWorkspaceDefault(state, PROJECT_KEY)).toEqual(projectDefault);
    expect(selectThreadWorkspaceDefault(state, "project:other")).toEqual(globalDefault);
  });

  test("detects whether saving would change a default", () => {
    const filesDefault = templateWithSurface("files");
    const restoredFilesDefault = parseThreadWorkspaceDefault(
      JSON.parse(JSON.stringify(filesDefault)),
    );
    expect(restoredFilesDefault).not.toBeNull();

    if (!restoredFilesDefault) return;

    expect(threadWorkspaceDefaultHasChanges(filesDefault, null)).toBe(true);
    expect(threadWorkspaceDefaultHasChanges(filesDefault, restoredFilesDefault)).toBe(false);
    expect(threadWorkspaceDefaultHasChanges(filesDefault, templateWithSurface("diff"))).toBe(true);
  });

  test("initialization copies a default only once", () => {
    const projectDefault = templateWithSurface("diff");
    useThreadWorkspaceDefaultStore.setState({
      globalDefault: templateWithSurface("files"),
      byProjectKey: { [PROJECT_KEY]: projectDefault },
    });

    expect(initializeNewThreadWorkspace(THREAD_REF, PROJECT_KEY)).toBe(true);
    expect(
      selectThreadWorkspaceLayout(useThreadWorkspaceLayoutStore.getState().byThreadKey, THREAD_REF),
    ).toEqual(projectDefault.layout);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual(projectDefault.rightPanel);

    useThreadWorkspaceDefaultStore
      .getState()
      .saveProject(PROJECT_KEY, templateWithSurface("files"));
    expect(initializeNewThreadWorkspace(THREAD_REF, PROJECT_KEY)).toBe(false);
    expect(
      useThreadWorkspaceLayoutStore.getState().byThreadKey[scopedThreadKey(THREAD_REF)],
    ).toEqual(projectDefault.layout);
  });

  test("drops malformed persisted defaults", () => {
    expect(parseThreadWorkspaceDefault({ layout: null, rightPanel: {} })).toBeNull();
    expect(
      parsePersistedThreadWorkspaceDefaults({
        globalDefault: { layout: null },
        byProjectKey: { broken: { layout: null } },
      }),
    ).toEqual({ globalDefault: null, byProjectKey: {} });
  });
});

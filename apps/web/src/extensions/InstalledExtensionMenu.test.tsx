import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SurfaceDescriptor, ViewContext } from "@t3tools/extension-sdk/contracts";
import { createJSONStorage } from "zustand/middleware";
import { createMemoryStorage } from "../lib/storage";
import {
  type ExtensionPanelSurface,
  type RightPanelSurface,
  selectThreadExtensionDock,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { InstalledExtensionMenu } from "./InstalledExtensionMenu";
const fixture = vi.hoisted(() => ({ installations: [] as unknown[] }));
vi.mock("./installedEnvironment", () => ({
  useInstalledExtensions: () => ({ installations: fixture.installations }),
}));
vi.mock("../components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../components/ui/menu", () => ({
  Menu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  MenuPopup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  MenuTrigger: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  MenuItem: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ref = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const context: ViewContext = {
  resource: {
    namespace: "t3.workspace",
    id: "extension-view",
    environmentId: ref.environmentId,
    projectId: "project-a",
    threadId: ref.threadId,
  },
  client: "web",
  workspaceRevision: JSON.stringify(["/workspace", null]),
};
const surface: SurfaceDescriptor = {
  id: "fixture.reader/view",
  title: "Reader",
  scope: "thread",
  capabilities: [],
  clients: ["web"],
  placements: ["side-panel", "bottom-dock"],
  stateVersion: 1,
};
const install = (descriptor = surface) => {
  fixture.installations = [
    {
      id: "fixture.reader",
      enabled: true,
      grants: { projectIds: ["project-a"] },
      package: { manifest: { surfaces: [descriptor] } },
    },
  ];
};
beforeEach(() => {
  install();
  useRightPanelStore.persist.setOptions({
    storage: createJSONStorage(() => createMemoryStorage()),
  });
  useRightPanelStore.setState({
    byThreadKey: {},
    extensionDockByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});
for (const placement of ["side-panel", "bottom-dock"] as const) {
  const state = () =>
    placement === "side-panel"
      ? selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref)
      : selectThreadExtensionDock(useRightPanelStore.getState().extensionDockByThreadKey, ref);
  const reader = () => {
    const surfaces: readonly RightPanelSurface[] = state().surfaces;
    return surfaces.find((item): item is ExtensionPanelSurface => item.kind === "extension")!;
  };
  const click = async (root: ReactTestRenderer) =>
    act(async () =>
      root.root
        .findAllByType("button")
        .find((button) =>
          button.children
            .join("")
            .includes(placement === "side-panel" ? "Side panel" : "Bottom dock"),
        )!
        .props.onClick(),
    );
  it(`menu reselect preserves current and inactive saved viewer in ${placement}`, async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<InstalledExtensionMenu threadRef={ref} context={context} />);
      });
      await click(root);
      const original = reader();
      if (original.kind !== "extension") throw new Error("Expected extension viewer");
      useRightPanelStore
        .getState()
        .updateExtensionRecord(
          ref,
          { ...original.record, restoreState: { relativePath: "new.txt" } },
          original.viewerGeneration,
        );
      const saved = reader();
      await click(root);
      expect(reader()).toBe(saved);
      if (placement === "side-panel") {
        useRightPanelStore.getState().open(ref, "files");
        useRightPanelStore.getState().close(ref);
      } else {
        useRightPanelStore.getState().openExtension(ref, {
          ...original.record,
          context: {
            ...original.record.context,
            resource: { ...original.record.context.resource, id: "other" },
          },
        });
        useRightPanelStore.getState().hideExtensionDock(ref);
      }
      await click(root);
      expect(reader()).toBe(saved);
      expect(state().isOpen).toBe(true);
      expect(state().activeSurfaceId).toBe(original.id);
      expect(reader()).toMatchObject({
        viewerGeneration: original.viewerGeneration,
        record: { restoreState: { relativePath: "new.txt" } },
      });
      await useRightPanelStore.persist.rehydrate();
      const hydrated = reader();
      expect(hydrated.viewerGeneration).toBeUndefined();
      await click(root);
      expect(reader()).toBe(hydrated);
      expect(reader()).toMatchObject({ record: { restoreState: { relativePath: "new.txt" } } });
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
  it(`menu replaces stale workspace or schema instead of reusing old grant context in ${placement}`, async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<InstalledExtensionMenu threadRef={ref} context={context} />);
      });
      await click(root);
      const original = reader();
      if (original.kind !== "extension") throw new Error("Expected extension viewer");
      useRightPanelStore
        .getState()
        .updateExtensionRecord(
          ref,
          { ...original.record, restoreState: { relativePath: "new.txt" } },
          original.viewerGeneration,
        );
      const nextContext = {
        ...context,
        workspaceRevision: JSON.stringify(["/workspace", "/new-worktree"]),
      };
      await act(async () =>
        root.update(<InstalledExtensionMenu threadRef={ref} context={nextContext} />),
      );
      await click(root);
      expect(reader()).toMatchObject({
        record: {
          restoreState: null,
          context: { workspaceRevision: nextContext.workspaceRevision },
        },
      });
      expect(reader().viewerGeneration).not.toBe(original.viewerGeneration);
      const next = reader();
      install({ ...surface, stateVersion: 2 });
      await act(async () =>
        root.update(<InstalledExtensionMenu threadRef={ref} context={nextContext} />),
      );
      await click(root);
      expect(reader()).toMatchObject({ record: { stateVersion: 2, restoreState: null } });
      expect(reader().viewerGeneration).not.toBe(next.viewerGeneration);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
}

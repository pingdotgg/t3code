import { DEFAULT_CLIENT_SETTINGS, type SavedThreadRowLayout } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const setup = vi.hoisted(() => ({ hydrated: false, setShowing: vi.fn() }));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => setup.hydrated,
  usePrimarySettingsAvailable: () => true,
}));

vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn(), setOpen: vi.fn() }),
}));

vi.mock("./ThreadListPreviewContext", () => ({
  useThreadListPreview: () => ({ showing: false, setShowing: setup.setShowing }),
}));

vi.mock("./ThreadRowLayoutEditor", () => ({
  ThreadRowLayoutEditor: ({
    renderHeader,
    footer,
  }: {
    renderHeader: (preview: ReactNode) => ReactNode;
    footer: ReactNode;
  }) => (
    <>
      {renderHeader(<div>Preview</div>)}
      {footer}
    </>
  ),
}));

import { ThreadRowLayoutSettings } from "./ThreadRowLayoutSettings";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setup.hydrated = false;
  setup.setShowing.mockClear();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function duplicateButton() {
  return renderer!.root.find(
    (node) => node.type === "button" && node.children.includes("Duplicate"),
  );
}

describe("thread row layout settings hydration", () => {
  it("does not build a saved-layout patch from the pre-hydration defaults", async () => {
    const onChange = vi.fn();
    await act(() => {
      renderer = create(
        <ThreadRowLayoutSettings settings={DEFAULT_CLIENT_SETTINGS} onChange={onChange} />,
      );
    });

    const preview = () =>
      renderer!.root.find(
        (node) => node.type === "button" && node.children.includes("Preview my threads"),
      );
    expect(preview().props.disabled).toBe(true);
    await act(() => preview().props.onClick());
    expect(setup.setShowing).not.toHaveBeenCalled();

    const duplicateBeforeHydration = duplicateButton();
    await act(() => duplicateBeforeHydration.props.onClick());
    expect(onChange).not.toHaveBeenCalled();
    expect(duplicateBeforeHydration.props.disabled).toBe(true);

    const existing: SavedThreadRowLayout = {
      id: "saved-review",
      name: "Review",
      layout: DEFAULT_CLIENT_SETTINGS.sidebarThreadRowLayout,
    };
    setup.hydrated = true;
    await act(() => {
      renderer!.update(
        <ThreadRowLayoutSettings
          settings={{
            ...DEFAULT_CLIENT_SETTINGS,
            sidebarSavedThreadLayouts: [existing],
          }}
          onChange={onChange}
        />,
      );
    });

    expect(preview().props.disabled).toBe(false);
    await act(() => preview().props.onClick());
    expect(setup.setShowing).toHaveBeenCalledWith(true);

    expect(duplicateButton().props.disabled).toBe(false);
    await act(() => duplicateButton().props.onClick());
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].sidebarSavedThreadLayouts).toEqual([
      existing,
      expect.objectContaining({ name: "Standard copy" }),
    ]);
  });
});

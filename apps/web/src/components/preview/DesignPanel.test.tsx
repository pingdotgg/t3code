import { act } from "react";
import { create } from "react-test-renderer";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { selectSelectedRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { DesignCanvas } from "./DesignCanvas";
import { DesignPanel } from "./DesignPanel";

vi.mock("./DesignCanvas", () => ({ DesignCanvas: () => null }));
const threadRef = { environmentId: "local", threadId: "design-navigation" } as ScopedThreadRef;

afterEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  vi.unstubAllGlobals();
});

it.each([1, 2])("returns to the list and reopens a design with %i files", async (count) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const designs = Array.from({ length: count }, (_, index) => ({
    tabId: `design-${index}`,
    title: `Design ${index}`,
    path: `.t3/designs/${index}.html`,
    url: `http://localhost/api/assets/${index}`,
  }));
  function Host() {
    const surface = useRightPanelStore((state) =>
      selectSelectedRightPanelSurface(state.byThreadKey, threadRef),
    );
    return (
      <DesignPanel
        threadRef={threadRef}
        designs={designs}
        tabId={surface?.kind === "design" ? surface.resourceId : null}
        visible
      />
    );
  }
  useRightPanelStore.getState().openDesign(threadRef, "design-0");
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(() => {
      renderer = create(<Host />);
    });
    expect(renderer!.root.findAllByType(DesignCanvas)).toHaveLength(1);
    await act(() => renderer!.root.findByType("button").props.onClick());
    expect(renderer!.root.findAllByType(DesignCanvas)).toHaveLength(0);
    expect(renderer!.root.findByType("h2").children).toEqual(["Designs"]);
    expect(renderer!.root.findAllByType("button")).toHaveLength(count);
    await act(() => renderer!.root.findAllByType("button")[0]!.props.onClick());
    expect(renderer!.root.findAllByType(DesignCanvas)).toHaveLength(1);
  } finally {
    await act(() => renderer?.unmount());
  }
});

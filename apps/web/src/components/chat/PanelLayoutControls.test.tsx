import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";

// Tooltips position through floating-ui, which needs a window. The hover
// hint is not under test; the button beneath it is.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));

import { PanelLayoutControls } from "./PanelLayoutControls";

const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

/**
 * Stands in for ChatView and the pull-requests route: both read the thread's
 * panel state from the store and hand the toggle a store-backed handler.
 */
function RightPanelToggleProbe({
  threadRef,
  available = true,
}: {
  threadRef: typeof threadA;
  available?: boolean;
}) {
  const panelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  return (
    <PanelLayoutControls
      terminalAvailable={available}
      terminalOpen={false}
      terminalShortcutLabel={null}
      rightPanelAvailable={available}
      rightPanelOpen={panelState.isOpen}
      rightPanelShortcutLabel={null}
      liveAgentCount={0}
      onToggleTerminal={() => undefined}
      onToggleRightPanel={() => useRightPanelStore.getState().toggleVisibility(threadRef)}
    />
  );
}

let renderer: ReactTestRenderer | undefined;

async function mount(element: ReactElement) {
  await act(() => {
    renderer = create(element);
  });
}

/** The one button a user, a screen reader, or the command palette reaches as the panel toggle. */
function rightPanelToggle(): ReactTestInstance {
  const buttons = renderer!.root.findAll(
    (node) =>
      node.type === "button" &&
      typeof node.props["aria-label"] === "string" &&
      node.props["aria-label"].startsWith("Toggle right panel"),
  );
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
}

async function press(button: ReactTestInstance) {
  await act(() => {
    button.props.onClick({ defaultPrevented: false, nativeEvent: {}, preventDefault() {} });
  });
}

const isOpen = (threadRef: typeof threadA) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("right panel toggle", () => {
  it("opens the panel on press and closes it on the next press", async () => {
    await mount(<RightPanelToggleProbe threadRef={threadA} />);
    expect(rightPanelToggle().props["aria-pressed"]).toBe(false);

    // A thread with no surfaces yet still opens, to the panel's empty state.
    await press(rightPanelToggle());
    expect(isOpen(threadA)).toBe(true);
    expect(rightPanelToggle().props["aria-pressed"]).toBe(true);

    // One press is one toggle: a double-fired handler would land back on closed.
    await press(rightPanelToggle());
    expect(isOpen(threadA)).toBe(false);
    expect(rightPanelToggle().props["aria-pressed"]).toBe(false);
  });

  it("keeps surfaces through a close so reopening restores them", async () => {
    useRightPanelStore.getState().open(threadA, "diff");
    await mount(<RightPanelToggleProbe threadRef={threadA} />);
    expect(rightPanelToggle().props["aria-pressed"]).toBe(true);

    await press(rightPanelToggle());
    expect(isOpen(threadA)).toBe(false);

    await press(rightPanelToggle());
    const reopened = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadA,
    );
    expect(reopened.isOpen).toBe(true);
    expect(reopened.activeSurfaceId).toBe("diff");
  });

  it("only affects the thread it belongs to", async () => {
    await mount(<RightPanelToggleProbe threadRef={threadA} />);
    await press(rightPanelToggle());
    expect(isOpen(threadA)).toBe(true);
    expect(isOpen(threadB)).toBe(false);

    await act(() => renderer!.update(<RightPanelToggleProbe threadRef={threadB} />));
    expect(rightPanelToggle().props["aria-pressed"]).toBe(false);
  });

  it("is disabled without a project and leaves the panel closed", async () => {
    await mount(<RightPanelToggleProbe threadRef={threadA} available={false} />);
    expect(rightPanelToggle().props.disabled).toBe(true);

    await press(rightPanelToggle());
    expect(isOpen(threadA)).toBe(false);
  });
});

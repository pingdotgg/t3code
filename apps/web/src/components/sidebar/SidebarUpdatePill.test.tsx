import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const testState = vi.hoisted(() => ({
  desktopUpdate: null as DesktopUpdateState | null,
  downloadUpdate: vi.fn<() => Promise<DesktopUpdateActionResult>>(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => testState.desktopUpdate,
}));

import { SidebarUpdatePill } from "./SidebarUpdatePill";

const availableState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "1.0.0-nightly.1",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "1.0.0-nightly.2",
  downloadedVersion: null,
  releaseNotes: [{ version: "1.0.0-nightly.2", items: ["fix: keep notes interactive"] }],
  downloadPercent: null,
  checkedAt: "2026-08-22T00:00:00.000Z",
  message: null,
  errorContext: null,
  canRetry: false,
};

type TestElement = ReactElement<Record<string, unknown>>;

function invokeComponent(element: TestElement): TestElement {
  if (typeof element.type !== "function") {
    throw new Error("Expected a function component");
  }
  const component = element.type as unknown as (props: Record<string, unknown>) => TestElement;
  return component(element.props);
}

function renderControl() {
  hooks.beginRender();
  const output = invokeComponent(SidebarUpdatePill() as TestElement);
  const releaseNotesPopover = findReleaseNotesPopover(output);
  return releaseNotesPopover ? invokeComponent(releaseNotesPopover) : output;
}

function renderControlElement() {
  hooks.beginRender();
  return invokeComponent(SidebarUpdatePill() as TestElement);
}

function findReleaseNotesPopover(output: TestElement) {
  return visitElements(
    output,
    (element) =>
      typeof element.type === "function" &&
      typeof element.props.renderTrigger === "function" &&
      element.props.state === testState.desktopUpdate,
  );
}

function findTrigger(output: TestElement) {
  const trigger = visitElements(
    output,
    (element) => element.type === "button" && typeof element.props["aria-label"] === "string",
  );
  if (!trigger) throw new Error("Expected update trigger");
  return trigger;
}

function installDesktopBridge() {
  vi.stubGlobal("window", {
    desktopBridge: {
      downloadUpdate: testState.downloadUpdate,
    },
  });
}

describe("SidebarUpdatePill release notes popover", () => {
  beforeEach(() => {
    hooks.reset();
    testState.desktopUpdate = availableState;
    testState.downloadUpdate.mockReset();
    testState.downloadUpdate.mockResolvedValue({
      accepted: true,
      completed: false,
      state: availableState,
    });
    installDesktopBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads from the sidebar trigger without toggling the popover", () => {
    const output = renderControl();
    const root = visitElements(
      output,
      (element) =>
        typeof element.props.open === "boolean" && typeof element.props.onOpenChange === "function",
    );
    if (!root) throw new Error("Expected update popover");
    const onOpenChange = root.props.onOpenChange as (open: boolean) => void;
    onOpenChange(true);

    const openedOutput = renderControl();
    const trigger = findTrigger(openedOutput);
    const preventBaseUIHandler = vi.fn();
    const onClick = trigger.props.onClick as
      | ((event: { preventBaseUIHandler: () => void }) => void)
      | undefined;

    onClick?.({ preventBaseUIHandler });

    const closedOutput = renderControl();
    const closedRoot = visitElements(closedOutput, (element) => element.props.open === false);

    expect(preventBaseUIHandler).toHaveBeenCalledTimes(1);
    expect(testState.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(closedRoot).not.toBeNull();
  });

  it("uses a hover popover containing only the changelog", () => {
    const output = renderControl();
    const popoverTrigger = visitElements(output, (element) => element.props.openOnHover === true);
    const popup = visitElements(output, (element) => element.props.initialFocus === false);
    const releaseNotes = visitElements(output, (element) => element.props.state === availableState);

    if (!releaseNotes) throw new Error("Expected release notes content");
    const releaseNotesOutput = invokeComponent(releaseNotes);
    const actionButton = visitElements(
      releaseNotesOutput,
      (element) =>
        element.type === "button" &&
        (element.props.children === "Download update" ||
          element.props.children === "Restart and install"),
    );

    expect(popoverTrigger?.props.delay).toBe(150);
    expect(popoverTrigger?.props.closeDelay).toBe(120);
    expect(popup?.props.className).toContain("max-w-[min(24rem");
    expect(popup?.props.tooltipStyle).toBeUndefined();
    expect(popup?.props.style).toBeUndefined();
    expect(popup?.props.viewportClassName).toContain("max-h-");
    expect(actionButton).toBeNull();
  });

  it("mounts the stateful popover only while release notes are eligible", () => {
    const eligibleOutput = renderControlElement();

    expect(findReleaseNotesPopover(eligibleOutput)).not.toBeNull();

    testState.desktopUpdate = { ...availableState, status: "checking", releaseNotes: [] };
    const ineligibleOutput = renderControlElement();

    expect(findReleaseNotesPopover(ineligibleOutput)).toBeNull();
  });

  it("closes focused release notes only after focus and pointer leave the popover", () => {
    const output = renderControl();
    const trigger = findTrigger(output);
    const onFocus = trigger.props.onFocus as (() => void) | undefined;

    onFocus?.();

    const focusedOutput = renderControl();
    const focusedRoot = visitElements(focusedOutput, (element) => element.props.open === true);
    const focusedTrigger = findTrigger(focusedOutput);
    const onBlur = focusedTrigger.props.onBlur as
      | ((event: {
          currentTarget: { getAttribute: (name: string) => string | null };
          relatedTarget: EventTarget | null;
        }) => void)
      | undefined;
    const matches = vi.fn(() => true);
    const contains = vi.fn(() => false);
    const popupId = "release-notes-popover";
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({ contains, matches })),
    });
    const blurEvent = {
      currentTarget: {
        getAttribute: (name: string) => (name === "aria-controls" ? popupId : null),
      },
      relatedTarget: {} as EventTarget,
    };

    expect(focusedRoot).not.toBeNull();

    onBlur?.(blurEvent);

    const hoveredOutput = renderControl();
    const hoveredRoot = visitElements(hoveredOutput, (element) => element.props.open === true);

    expect(hoveredRoot).not.toBeNull();

    matches.mockReturnValue(false);
    contains.mockReturnValue(true);
    onBlur?.(blurEvent);

    const containedFocusOutput = renderControl();
    const containedFocusRoot = visitElements(
      containedFocusOutput,
      (element) => element.props.open === true,
    );

    expect(containedFocusRoot).not.toBeNull();

    contains.mockReturnValue(false);
    onBlur?.(blurEvent);

    const blurredOutput = renderControl();
    const blurredRoot = visitElements(blurredOutput, (element) => element.props.open === false);

    expect(blurredRoot).not.toBeNull();
  });

  it.each([
    { channel: "latest" as const, releaseNotes: availableState.releaseNotes },
    { channel: "nightly" as const, releaseNotes: [] },
  ])("keeps the existing tooltip when release notes are unavailable", (stateOverride) => {
    testState.desktopUpdate = { ...availableState, ...stateOverride };

    const output = renderControl();
    const popoverTrigger = visitElements(output, (element) => element.props.openOnHover === true);

    expect(popoverTrigger).toBeNull();
    expect(findTrigger(output)).toBeDefined();
  });
});

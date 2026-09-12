import type { DesktopUpdateState } from "@t3tools/contracts";
import { isValidElement, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

type AnchorElement = ReactElement<{
  readonly children?: ReactNode;
  readonly href?: string;
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}>;

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function collectAnchors(node: ReactNode, anchors: AnchorElement[] = []): AnchorElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectAnchors(child, anchors);
    return anchors;
  }
  if (!isValidElement(node)) return anchors;

  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  if (typeof element.type === "function") {
    const render = element.type as (props: unknown) => ReactNode;
    return collectAnchors(render(element.props), anchors);
  }
  if (element.type === "a") anchors.push(element as AnchorElement);
  return collectAnchors(element.props.children, anchors);
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement(node)) return "";
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  return textContent(element.props.children);
}

function renderNotes(state: DesktopUpdateState, openExternal = vi.fn().mockResolvedValue(true)) {
  return SidebarUpdateReleaseNotes({
    shell: { openExternal },
    state,
    tooltip: "Update available",
  });
}

describe("SidebarUpdateReleaseNotes", () => {
  beforeEach(() => {
    testState.addToast.mockReset();
  });

  it("links each preview to its exact release and labels hidden changes", () => {
    const anchors = collectAnchors(
      renderNotes({
        ...baseState,
        releaseNotes: [
          { version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 },
          { version: "0.0.36-nightly.2", items: ["Change 2"], totalItems: 2 },
          { version: "0.0.36-nightly.1", items: ["Change 1", "Earlier"], totalItems: 4 },
        ],
      }),
    );

    expect(anchors.map(({ props }) => props.href)).toEqual([
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.3",
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.2",
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.1",
    ]);
    expect(anchors.map(({ props }) => textContent(props.children))).toEqual([
      "View release on GitHub",
      "1 more change on GitHub",
      "2 more changes on GitHub",
    ]);
  });

  it("links omitted releases to release history", () => {
    const anchors = collectAnchors(
      renderNotes({
        ...baseState,
        releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
        omittedReleaseCount: 1,
      }),
    );

    expect(anchors.at(-1)?.props.href).toBe("https://github.com/pingdotgg/t3code/releases");
    expect(textContent(anchors.at(-1)?.props.children)).toBe("1 older release on GitHub");
  });

  it("shows plural history text for multiple omitted releases", () => {
    const anchors = collectAnchors(
      renderNotes({
        ...baseState,
        releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
        omittedReleaseCount: 3,
      }),
    );

    expect(textContent(anchors.at(-1)?.props.children)).toBe("3 older releases on GitHub");
  });

  it("reports a release link that fails to open", async () => {
    const openExternal = vi.fn().mockResolvedValue(false);
    const [anchor] = collectAnchors(
      renderNotes(
        {
          ...baseState,
          releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Change 3"], totalItems: 1 }],
        },
        openExternal,
      ),
    );
    const preventDefault = vi.fn();

    anchor?.props.onClick?.({ preventDefault } as unknown as MouseEvent<HTMLAnchorElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36-nightly.3",
      );
      expect(testState.addToast).toHaveBeenCalledWith({
        type: "error",
        title: "Unable to open release notes",
      });
    });
  });
});

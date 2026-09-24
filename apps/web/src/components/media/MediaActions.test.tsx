import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const contextMenuState = vi.hoisted(() => ({ show: vi.fn() }));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: contextMenuState.show },
  }),
}));
vi.mock("../../remoteOpen", () => ({
  remotePathCopyQualifier: () => "sol",
  remotePathScpHost: () => "sol",
  useRemoteOpenResolution: () => ({
    state: { mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } },
    isResolved: true,
    environmentLabel: "sol",
  }),
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(), update: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    TooltipTrigger: ({
      render,
      ...rest
    }: { render: React.ReactElement } & Record<string, unknown>) => {
      if (!isValidElement(render)) return render;
      return cloneElement(render, rest);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { toastManager } from "../ui/toast";
import { MediaActions } from "./MediaActions";

describe("MediaActions", () => {
  it("does not describe a copied URL as a host path", async () => {
    contextMenuState.show.mockResolvedValue("copy-url");
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <MediaActions
          source={{
            kind: "image",
            name: "diagram.png",
            src: "https://example.com/diagram.png",
            reference: { kind: "url", url: "https://example.com/diagram.png" },
          }}
        >
          <img alt="diagram" />
        </MediaActions>,
      );
    });

    const img = renderer!.root.findByType("img");
    const { onContextMenu } = img.props as ComponentProps<"img">;
    if (!onContextMenu) throw new Error("Media element has no context menu handler");
    await act(async () => {
      await onContextMenu({
        defaultPrevented: false,
        preventDefault: () => {},
        stopPropagation: () => {},
        clientX: 10,
        clientY: 10,
        currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) },
      } as unknown as Parameters<NonNullable<typeof onContextMenu>>[0]);
    });

    expect(vi.mocked(toastManager.add)).toHaveBeenCalledWith(
      expect.objectContaining({ title: "URL copied" }),
    );
    const [toast] = vi.mocked(toastManager.add).mock.calls[0]!;
    expect(toast).not.toHaveProperty("description");
  });
});

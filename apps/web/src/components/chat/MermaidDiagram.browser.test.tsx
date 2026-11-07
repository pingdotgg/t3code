import { Suspense, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";
import { MarkdownDetails } from "./MarkdownDetails";
import { MermaidDiagram } from "./MermaidDiagram";

const FLOW = "flowchart LR\nA-->B";

const { mountSpy } = vi.hoisted(() => ({
  mountSpy: vi.fn<(typeof import("pele/lazy"))["mount"]>(),
}));

vi.mock(import("pele/lazy"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    mount: ((element, text, options) => {
      mountSpy(element, text, options);
      // Collapsed hosts used to mount immediately and surface Pele errors into React.
      if (!(element.clientWidth > 0)) {
        const error = new Error("Diagram host has no width");
        options?.onError?.(error);
        return {
          result: undefined,
          source: text,
          error,
          zoom: undefined,
          update: () => undefined,
          refresh: () => undefined,
          destroy: () => undefined,
        };
      }
      return actual.mount(element, text, options);
    }) satisfies (typeof import("pele/lazy"))["mount"],
  };
});

function ZeroSizeHost({ children }: { children: ReactNode }) {
  return <div className="h-0 w-0 overflow-hidden">{children}</div>;
}

function ExpandableHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <div className={open ? "w-[480px]" : "w-0 overflow-hidden"}>{children}</div>
    </div>
  );
}

describe("MermaidDiagram in collapsed containers", () => {
  it("does not mount or show an error while the host has no width", async () => {
    mountSpy.mockClear();
    await using screen = await render(
      <ZeroSizeHost>
        <Suspense fallback={null}>
          <MermaidDiagram source={FLOW} onExpand={() => undefined} />
        </Suspense>
      </ZeroSizeHost>,
      // No router: this is an isolated diagram host.
      { router: false },
    );

    await act(async () => {
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(screen.container.querySelector("[data-markdown-mermaid]")).not.toBeNull();
    });

    expect(mountSpy).not.toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain("Unable to render diagram");
    expect(screen.container.querySelector(".pele-error")).toBeNull();
  });

  it("mounts and renders after the host gains width", async () => {
    mountSpy.mockClear();
    await using screen = await render(
      <ExpandableHost>
        <Suspense fallback={null}>
          <MermaidDiagram source={FLOW} onExpand={() => undefined} />
        </Suspense>
      </ExpandableHost>,
      // No router: this is an isolated diagram host.
      { router: false },
    );

    await vi.waitFor(() => {
      expect(screen.container.querySelector("[data-markdown-mermaid]")).not.toBeNull();
    });
    expect(mountSpy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await vi.waitFor(() => {
      expect(mountSpy).toHaveBeenCalled();
      expect(screen.container.querySelector("[data-markdown-mermaid] svg")).not.toBeNull();
      expect(screen.container.textContent).not.toContain("Unable to render diagram");
    });
  });

  it("renders inside MarkdownDetails after expand", async () => {
    mountSpy.mockClear();
    await using screen = await render(
      <div className="w-[480px]">
        <MarkdownDetails>
          <summary>Plan</summary>
          <Suspense fallback={null}>
            <MermaidDiagram source={FLOW} onExpand={() => undefined} />
          </Suspense>
        </MarkdownDetails>
      </div>,
      // No router: this is an isolated details host.
      { router: false },
    );

    expect(screen.container.textContent).not.toContain("Unable to render diagram");
    expect(mountSpy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Plan/ }));
    await vi.waitFor(() => {
      expect(mountSpy).toHaveBeenCalled();
      expect(screen.container.querySelector("[data-markdown-mermaid] svg")).not.toBeNull();
    });
  });

  it("keeps a successful diagram when a later Pele error arrives", async () => {
    mountSpy.mockClear();
    await using screen = await render(
      <div className="w-[480px]">
        <Suspense fallback={null}>
          <MermaidDiagram source={FLOW} onExpand={() => undefined} />
        </Suspense>
      </div>,
      // No router: this is an isolated diagram host.
      { router: false },
    );

    await vi.waitFor(() => {
      expect(screen.container.querySelector("[data-markdown-mermaid] svg")).not.toBeNull();
    });

    const options = mountSpy.mock.calls.at(-1)?.[2];
    await act(() => {
      options?.onError?.(new Error("resize while collapsed"));
    });

    await vi.waitFor(() => {
      expect(screen.container.textContent).not.toContain("Unable to render diagram");
      expect(screen.container.querySelector("[data-markdown-mermaid] svg")).not.toBeNull();
    });
  });

  it("recovers when source changes after a render error", async () => {
    mountSpy.mockClear();
    await using screen = await render(
      <div className="w-[480px]">
        <Suspense fallback={null}>
          <MermaidDiagram source={"flowchart LR\nA-->"} onExpand={() => undefined} />
        </Suspense>
      </div>,
      // No router: this is an isolated diagram host.
      { router: false },
    );

    await vi.waitFor(() => {
      expect(screen.container.textContent).toContain("Unable to render diagram");
      expect(screen.container.querySelector("[data-markdown-mermaid] button")).toHaveAttribute(
        "hidden",
      );
    });

    await screen.rerender(
      <div className="w-[480px]">
        <Suspense fallback={null}>
          <MermaidDiagram source={FLOW} onExpand={() => undefined} />
        </Suspense>
      </div>,
    );

    await vi.waitFor(() => {
      expect(screen.container.querySelector("[data-markdown-mermaid] svg")).not.toBeNull();
      expect(screen.container.textContent).not.toContain("Unable to render diagram");
    });
  });
});

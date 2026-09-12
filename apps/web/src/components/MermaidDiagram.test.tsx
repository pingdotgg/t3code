import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

import MermaidDiagram from "./MermaidDiagram";

/** Provides a representative source-code fallback for diagram tests. */
function fallback(): ReactNode {
  return <pre>{"flowchart TD\\n  invalid"}</pre>;
}

describe("MermaidDiagram", () => {
  beforeEach(() => {
    mermaid.initialize.mockClear();
    mermaid.render.mockReset();
  });

  it("renders the returned SVG without binding Mermaid events", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mermaid.render.mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 100 100"><circle r="10" /></svg>',
    });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <MermaidDiagram
            code="flowchart TD\n  start --> finish"
            fallback={fallback()}
            theme="dark"
          />,
        );
      });
      const diagram = renderer!.root.findByProps({ "data-mermaid-diagram": "" });
      expect(diagram.props.dangerouslySetInnerHTML.__html).toContain("<svg");
      expect(mermaid.initialize).toHaveBeenCalledWith({
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: "dark",
      });
      expect(mermaid.render).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the source with an error indicator when rendering fails", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mermaid.render.mockRejectedValueOnce(new Error("Parse error"));
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <MermaidDiagram code="flowchart TD\n  invalid" fallback={fallback()} theme="light" />,
        );
      });
      expect(renderer!.root.findByProps({ "data-mermaid-error": "" })).toBeDefined();
      expect(renderer!.root.findByType("pre").props.children).toContain("invalid");
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});

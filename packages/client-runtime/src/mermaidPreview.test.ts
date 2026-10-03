import { describe, expect, it } from "vite-plus/test";
import {
  canPreviewMermaid,
  renderMermaidPreview,
  hasClosedMermaidFence,
} from "./mermaidPreview.js";

const signal = () => new AbortController().signal;

describe("static Mermaid previews", () => {
  it("recognizes only closed Mermaid fences, not text inside another code block", () => {
    const source = "flowchart LR\nA --> B";
    expect(hasClosedMermaidFence(`\u0060\u0060\u0060mermaid\n${source}`, source)).toBe(false);
    expect(
      hasClosedMermaidFence(`\u0060\u0060\u0060mermaid\n${source}\n\u0060\u0060\u0060`, source),
    ).toBe(true);
    expect(
      hasClosedMermaidFence(
        `~~~~text\n\u0060\u0060\u0060mermaid\n${source}\n\u0060\u0060\u0060\n~~~~`,
        source,
      ),
    ).toBe(false);
  });
  it("renders visible labels, dimensions and themed output using the real engine", async () => {
    const source = "flowchart LR\nA[Start]  -->  B[Finish]";
    const dark = await renderMermaidPreview(source, "dark", signal());
    expect(dark.svg).toContain("Start");
    expect(dark.svg).toContain("Finish");
    expect(dark.width).toBeGreaterThan(0);
    expect(dark.height).toBeGreaterThan(0);
    expect(await renderMermaidPreview(source, "dark", signal())).toBe(dark);
    expect((await renderMermaidPreview(source, "light", signal())).svg).not.toBe(dark.svg);
  });
  it("rejects ambiguous identical unfinished native fences", () => {
    const source = "flowchart LR\nA --> B";
    expect(hasClosedMermaidFence(`~~~mermaid\n${source}\n~~~\n~~~mermaid\n${source}`, source)).toBe(
      false,
    );
  });
  it.each([
    "flowchart LR\nA --> B\nB[Finish]",
    "flowchart LR\nA[old]\nA[new] --> B",
    'flowchart LR\nA["`**bold**`"] --> B',
    "flowchart LR\nA --> B; B --> C",
    "flowchart LR\nA & B --> C & D",
    "sequenceDiagram\nAlice->>Bob: Request\nactivate Bob",
    "sequenceDiagram\nBob--xAlice: failed",
    "stateDiagram-v2\nA --> B\nnote right of A: important",
    "flowchart LR\nA --> B\n&#115;tyle A fill:red",
    "flowchart LR\nA-->B",
    'flowchart TD\nA --> B\nclick A "javascript:alert(1)"',
    "flowchart TD\nA --> B\nstyle A fill:url(https://evil.test/a)",
    "flowchart TD\nA --> B\nclassDef x fill:red",
    '%%{init: {securityLevel: "loose"}}%%\nflowchart TD\nA --> B',
    "---\nconfig: {}\n---\nflowchart TD\nA --> B",
    'pie\n"Example": 10',
    "flowchart TD\n" + "A --> B\n".repeat(121),
    "flowchart TD\n" + "x".repeat(8000),
  ])("leaves unsupported or unsafe input as source: %s", async (source) => {
    expect(canPreviewMermaid(source)).toBe(false);
    await expect(renderMermaidPreview(source, "dark", signal())).rejects.toThrow();
  });
  it("escapes hostile labels without adding executable SVG", async () => {
    const result = await renderMermaidPreview(
      'flowchart TD\nA["<script>alert(1)</script>"]  -->  B["Finish"]',
      "dark",
      signal(),
    );
    expect(result.svg).not.toContain("<script>");
    expect(result.svg).toContain("&lt;script&gt;");
  });
  it("skips cancelled work and recovers after a failed render", async () => {
    const controller = new AbortController();
    const cancelled = renderMermaidPreview(
      "flowchart LR\nA[Cancelled]  -->  B",
      "dark",
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    await expect(renderMermaidPreview("classDiagram\n???", "dark", signal())).rejects.toThrow();
    const valid = await renderMermaidPreview(
      "sequenceDiagram\nAlice->>Bob: Recovered",
      "dark",
      signal(),
    );
    expect(valid.svg).toContain("Recovered");
  });
  it("bounds pending work and releases slots after cancellation", async () => {
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const tasks = controllers.map((controller, i) =>
      renderMermaidPreview(`flowchart LR\nA[Queue ${i}] --> B`, "dark", controller.signal),
    );
    const settled = Promise.allSettled(tasks);
    await expect(
      renderMermaidPreview("flowchart LR\nA[Overflow] --> B", "dark", signal()),
    ).rejects.toThrow("Too many");
    controllers.forEach((controller) => controller.abort());
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(
      (await renderMermaidPreview("flowchart LR\nA[Next] --> B", "dark", signal())).svg,
    ).toContain("Next");
  });
});

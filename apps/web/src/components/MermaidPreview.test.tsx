// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MermaidPreview } from "./MermaidPreview";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const mounted: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => mounted.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

function mount(source: string, enabled = true) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  mounted.push(root);
  const render = (text: string, eligible = true) =>
    root.render(
      <MermaidPreview source={text} theme="dark" enabled={eligible}>
        <pre>{text}</pre>
      </MermaidPreview>,
    );
  return { element, root, render, source, enabled };
}

describe("explicit diagram preview", () => {
  it("loads a real diagram only on request and keeps the source through hide", async () => {
    const source = "flowchart LR\nA[Start] --> B[Finish]";
    const app = mount(source);
    await act(async () => app.render(source));
    expect(app.element.querySelector("img")).toBeNull();
    await act(async () => app.element.querySelector("button")!.click());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(app.element.querySelector("img")).not.toBeNull();
    });
    const svg = decodeURIComponent(
      app.element.querySelector("img")!.getAttribute("src")!.split(",")[1]!,
    );
    expect(svg).toContain("Start");
    expect(svg).toContain("Finish");
    expect(app.element.querySelector("pre")!.textContent).toBe(source);
    await act(async () => app.element.querySelector("button")!.click());
    expect(app.element.querySelector("img")).toBeNull();
    expect(app.element.querySelector("pre")!.textContent).toBe(source);
  });
  it("does not automatically layout a source replaced by streaming updates", async () => {
    const source = "flowchart LR\nA[Original] --> B";
    const app = mount(source);
    await act(async () => app.render(source));
    await act(async () => {
      app.element.querySelector("button")!.click();
      app.render("flowchart LR\nA[Changed] --> B", false);
    });
    expect(app.element.querySelector("img")).toBeNull();
    expect(app.element.querySelector("button")).toBeNull();
    await act(async () => app.render("flowchart LR\nA[Changed] --> B"));
    expect(app.element.querySelector("img")).toBeNull();
    expect(app.element.querySelector("button")!.textContent).toBe("Preview diagram");
  });
  it("recovers from invalid source after a new explicit request", async () => {
    const app = mount("classDiagram\n???");
    await act(async () => app.render(app.source));
    expect(app.element.querySelector("button")).toBeNull();
    expect(app.element.querySelector("pre")!.textContent).toBe(app.source);
    const next = "sequenceDiagram\nAlice->>Bob: Recovered";
    await act(async () => app.render(next));
    await act(async () => app.element.querySelector("button")!.click());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(app.element.querySelector("img")).not.toBeNull();
    });
    expect(app.element.textContent).not.toContain("Could not preview");
  });
});

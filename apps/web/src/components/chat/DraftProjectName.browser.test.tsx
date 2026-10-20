import "~/index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  host.style.width = "700px";
  host.style.zoom = "1.31";
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(value: string, placement: "headline" | "row") {
  await act(async () => {
    root.render(
      placement === "headline" ? (
        <h1 className="w-full text-center text-3xl tracking-tight">
          What should we build in{" "}
          <span className="whitespace-nowrap">
            <InlineButton tone="picker" className="max-w-[calc(100%-1em)] align-baseline">
              <DraftProjectName value={value} />
            </InlineButton>
            ?
          </span>
        </h1>
      ) : (
        <div className="flex w-full items-center gap-2 text-sm font-medium">
          <span className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <DraftProjectName value={value} />
          </span>
        </div>
      ),
    );
  });
}

function label() {
  return host.querySelector<HTMLSpanElement>("span[aria-label]")!;
}

it.each(["headline", "row"] as const)(
  "keeps fitting names in the %s even when canvas metrics disagree with layout",
  async (placement) => {
    host.style.zoom = "1";
    const measureText = CanvasRenderingContext2D.prototype.measureText;
    vi.spyOn(CanvasRenderingContext2D.prototype, "measureText").mockImplementation(function (
      this: CanvasRenderingContext2D,
      text,
    ) {
      const metrics = measureText.call(this, text);
      Object.defineProperty(metrics, "width", { value: metrics.width + 8 });
      return metrics;
    });

    for (const value of ["t3code", "mozart_v2", "No project", "Add project"]) {
      await render(value, placement);
      expect(label().textContent).toBe(value);
    }
  },
);

it.each(["headline", "row"] as const)(
  "fits long names in the %s and restores them when the available space grows",
  async (placement) => {
    const value = "ExampleCompany-CustomerPortal-App";
    await render(value, placement);
    expect(label().textContent).toBe(value);

    await act(async () => {
      host.style.width = "180px";
      await expect.poll(() => label().textContent).toContain("…");
    });
    const shortened = label().textContent!;
    expect(shortened.startsWith("Ex")).toBe(true);
    expect(shortened.endsWith("App")).toBe(true);
    const text = document.createRange();
    text.selectNodeContents(label());
    expect(text.getBoundingClientRect().width).toBeLessThanOrEqual(
      label().getBoundingClientRect().width,
    );

    await act(async () => {
      host.style.width = "700px";
      await expect.poll(() => label().textContent).toBe(value);
    });
  },
);

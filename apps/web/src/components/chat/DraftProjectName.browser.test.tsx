import "~/index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { InlineButton } from "../ui/button";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { DraftProjectName } from "./DraftProjectName";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  host.style.width = "700px";
  host.style.maxWidth = "100%";
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(value: string, placement: "headline" | "row" = "headline") {
  await act(async () => {
    root.render(
      placement === "headline" ? (
        <div data-testid="composer" className="relative mt-64 h-32 w-full">
          <div className="absolute inset-x-0 bottom-full pb-4">
            <DraftHeroProjectHeading projectName={value}>
              <InlineButton tone="picker" className="min-w-0 max-w-full align-baseline">
                <DraftProjectName value={value} singleLine />
              </InlineButton>
            </DraftHeroProjectHeading>
          </div>
        </div>
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

const label = () => host.querySelector<HTMLSpanElement>("span[aria-label]")!;
const title = () => host.querySelector<HTMLSpanElement>("h1 > span")!;

function expectWithinHost(element: Element) {
  const bounds = element.getBoundingClientRect();
  const hostBounds = host.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(hostBounds.left);
  expect(bounds.right).toBeLessThanOrEqual(hostBounds.right);
}

function expectAboveComposer() {
  const heading = host.querySelector("h1")!;
  const composer = host.querySelector('[data-testid="composer"]')!;
  expectWithinHost(heading);
  expectWithinHost(label());
  expect(heading.getBoundingClientRect().bottom).toBeLessThan(composer.getBoundingClientRect().top);
}

it.each([320, 390, 822])(
  "places the full short project name below the title in smaller text at %ipx",
  async (width) => {
    await page.viewport(width, 800);
    host.style.width = `${width - 32}px`;
    for (const value of ["t3code", "obsidian-arr", "No project"]) {
      await render(value);
      expect(title().innerText).toBe("What should we build?");
      expect(label().textContent).toBe(value);
      expect(label().scrollWidth).toBeLessThanOrEqual(label().clientWidth);
      expect(label().scrollHeight).toBeLessThanOrEqual(label().clientHeight);
      expect(label().getBoundingClientRect().top).toBeGreaterThanOrEqual(
        title().getBoundingClientRect().bottom,
      );
      expect(Number.parseFloat(getComputedStyle(label()).fontSize)).toBeLessThan(
        Number.parseFloat(getComputedStyle(title()).fontSize),
      );
      expectAboveComposer();
    }
  },
);

it("uses the inline heading only when the viewport and chat lane both have room", async () => {
  await page.viewport(1440, 900);
  await render("obsidian-arr");
  expect(title().innerText).toBe("What should we build in");
  expect(label().getBoundingClientRect().top).toBeLessThan(title().getBoundingClientRect().bottom);
  expectAboveComposer();

  host.style.width = "350px";
  await expect.poll(() => title().innerText).toBe("What should we build?");
  expect(label().getBoundingClientRect().top).toBeGreaterThanOrEqual(
    title().getBoundingClientRect().bottom,
  );
  expectAboveComposer();
});

it.each([390, 1440])(
  "uses a single smaller row and truncates only its remaining overflow at %ipx",
  async (width) => {
    await page.viewport(width, 900);
    host.style.width = `${Math.min(width - 32, 700)}px`;
    const value = "ExampleCompany-CustomerPortal-Production-".repeat(5);
    await render(value);
    expect(label().textContent).toBe(value);
    expect(label().getAttribute("aria-label")).toBe(value);
    expect(title().innerText).toBe("What should we build?");
    expect(label().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      title().getBoundingClientRect().bottom,
    );
    expect(Number.parseFloat(getComputedStyle(label()).fontSize)).toBeLessThan(
      Number.parseFloat(getComputedStyle(title()).fontSize),
    );
    expect(label().scrollWidth).toBeGreaterThan(label().clientWidth);
    expect(label().clientHeight).toBe(Number.parseFloat(getComputedStyle(label()).lineHeight));
    expect(getComputedStyle(label()).textOverflow).toBe("ellipsis");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expectAboveComposer();
  },
);

it("keeps short picker rows intact and bounds long rows at fractional zoom", async () => {
  await page.viewport(1280, 800);
  host.style.width = "240px";
  host.style.zoom = "1.31";
  for (const value of ["t3code", "obsidian-arr", "Add project", "LongProjectName-".repeat(10)]) {
    await render(value, "row");
    expect(label().textContent).toBe(value);
    expectWithinHost(label());
    expect(label().clientHeight).toBeLessThanOrEqual(
      Number.parseFloat(getComputedStyle(label()).lineHeight) * 2,
    );
  }
});

it("moves a name below the heading when it stops fitting and returns it inline when space recovers", async () => {
  await page.viewport(1440, 900);
  host.style.width = "900px";
  const value = "CustomerPortal-Production";
  await render(value);
  expect(title().innerText).toBe("What should we build in");

  await act(async () => {
    host.style.width = "650px";
    await expect.poll(() => title().innerText).toBe("What should we build?");
  });
  expect(label().textContent).toBe(value);
  expect(label().scrollWidth).toBeLessThanOrEqual(label().clientWidth);
  expect(label().scrollHeight).toBeLessThanOrEqual(label().clientHeight);
  expectAboveComposer();

  await act(async () => {
    host.style.width = "900px";
    await expect.poll(() => title().innerText).toBe("What should we build in");
  });
  expect(label().textContent).toBe(value);
  expectAboveComposer();
});

it("rechecks inline fit when the selected project changes", async () => {
  await page.viewport(1440, 900);
  await render("ExampleCompany-CustomerPortal-Production-Environment");
  expect(title().innerText).toBe("What should we build?");

  await render("obsidian-arr");
  await expect.poll(() => title().innerText).toBe("What should we build in");
  expect(label().textContent).toBe("obsidian-arr");

  await render("ExampleCompany-CustomerPortal-Production-Environment");
  await expect.poll(() => title().innerText).toBe("What should we build?");
  expect(label().scrollWidth).toBeLessThanOrEqual(label().clientWidth);
  expect(label().scrollHeight).toBeLessThanOrEqual(label().clientHeight);
  expectAboveComposer();
});

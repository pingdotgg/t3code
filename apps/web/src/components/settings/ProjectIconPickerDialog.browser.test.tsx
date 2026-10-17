import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string) {
  return vi.waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>("button, [role='radio']")].find(
      (element) => element.getAttribute("aria-label") === name || element.textContent === name,
    );
    if (!match) throw new Error(`No button ${name}`);
    return match;
  });
}

// The modal's inert backdrop covers the unstyled popup, so Playwright pointer clicks land on it.
async function click(name: string) {
  const target = await button(name);
  await act(async () => target.click());
}

async function openPicker() {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  await act(async () =>
    root.render(
      <ProjectIconPickerDialog
        current={null}
        projectName="Test"
        open
        onOpenChange={onOpenChange}
        onSelect={onSelect}
      />,
    ),
  );
  return { onSelect, onOpenChange };
}

describe("ProjectIconPickerDialog", () => {
  it("starts an automatic project on icons in its derived color and saves the picked icon", async () => {
    const { onSelect, onOpenChange } = await openPicker();
    const { color } = deriveProjectIdentity("Test");
    expect((await button("Icons")).getAttribute("aria-pressed")).toBe("true");
    expect(
      document.querySelector('[aria-label="Icon color"] [aria-pressed="true"]'),
    ).not.toBeNull();

    await userEvent.fill(searchBox(), "rocket");
    await click("Rocket");
    await click("Save icon");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: "lucide", name: "rocket", color });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("saves a monogram only once the letters are letters or numbers", async () => {
    const { onSelect } = await openPicker();
    await click("Monogram");
    const letters = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("#project-monogram");
      if (!input) throw new Error("No monogram input");
      return input;
    });

    await userEvent.fill(letters, "t-3");
    await click("Save icon");
    expect(onSelect).not.toHaveBeenCalled();

    await userEvent.fill(letters, "t3");
    await click("Save icon");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      kind: "monogram",
      text: "T3",
      color: deriveProjectIdentity("Test").color,
    });
  });
});

function searchBox() {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search Lucide icons"]')!;
}

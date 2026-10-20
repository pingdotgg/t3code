import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

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
  const screen = await render(
    <ProjectIconPickerDialog
      current={null}
      projectName="Test"
      open
      onOpenChange={onOpenChange}
      onSelect={onSelect}
    />,
  );
  return Object.assign(screen, { onSelect, onOpenChange });
}

describe("ProjectIconPickerDialog", () => {
  it("starts an automatic project on icons in its derived color and saves the picked icon", async () => {
    await using screen = await openPicker();
    const { onSelect, onOpenChange } = screen;
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
    await using screen = await openPicker();
    const { onSelect } = screen;
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

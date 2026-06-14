import "../../index.css";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetVscodeIconLoadStoreForTests } from "../../vscode-icon-load-store";

vi.mock("../../vscode-icons", () => ({
  getVscodeIconUrlForEntry: () => "http://192.0.2.1/test-vscode-icon.svg",
}));

import { VscodeEntryIcon } from "./VscodeEntryIcon";

describe("VscodeEntryIcon", () => {
  beforeEach(() => {
    __resetVscodeIconLoadStoreForTests();
    document.body.innerHTML = "";
  });

  it("updates sibling icons that share a URL when one image loads", async () => {
    const screen = await render(
      <div>
        <VscodeEntryIcon pathValue="src/first.ts" kind="file" theme="dark" />
        <VscodeEntryIcon pathValue="src/second.ts" kind="file" theme="dark" />
      </div>,
    );

    try {
      let images = iconImages(screen.container);
      expect(images).toHaveLength(2);
      expect(fallbackIcons(screen.container)).toHaveLength(2);
      expect(images.every((image) => image.classList.contains("hidden"))).toBe(true);

      images[0]?.dispatchEvent(new Event("load"));

      await vi.waitFor(() => {
        images = iconImages(screen.container);
        expect(images).toHaveLength(2);
        expect(fallbackIcons(screen.container)).toHaveLength(0);
        expect(images.every((image) => image.classList.contains("hidden"))).toBe(false);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("updates sibling icons that share a URL when one image fails", async () => {
    const screen = await render(
      <div>
        <VscodeEntryIcon pathValue="src/first.ts" kind="file" theme="dark" />
        <VscodeEntryIcon pathValue="src/second.ts" kind="file" theme="dark" />
      </div>,
    );

    try {
      const images = iconImages(screen.container);
      expect(images).toHaveLength(2);
      expect(fallbackIcons(screen.container)).toHaveLength(2);

      images[0]?.dispatchEvent(new Event("error"));

      await vi.waitFor(() => {
        expect(iconImages(screen.container)).toHaveLength(0);
        expect(fallbackIcons(screen.container)).toHaveLength(2);
      });
    } finally {
      await screen.unmount();
    }
  });
});

function iconImages(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll<HTMLImageElement>('img[aria-hidden="true"]')];
}

function fallbackIcons(container: HTMLElement): SVGSVGElement[] {
  return [...container.querySelectorAll<SVGSVGElement>("svg")];
}

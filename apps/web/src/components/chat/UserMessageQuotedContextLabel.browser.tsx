import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { ParsedQuotedContextEntry } from "../../lib/quotedContext";
import { UserMessageQuotedContextLabel } from "./UserMessageQuotedContextLabel";

async function mountLabel(contexts: ReadonlyArray<ParsedQuotedContextEntry>) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<UserMessageQuotedContextLabel contexts={contexts} />, {
    container: host,
  });
  return {
    host,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("UserMessageQuotedContextLabel", () => {
  afterEach(() => {
    for (const node of [...document.body.children]) {
      node.remove();
    }
  });

  it("renders nothing when there are no contexts", async () => {
    const mounted = await mountLabel([]);
    try {
      expect(mounted.host.textContent ?? "").toBe("");
      expect(mounted.host.querySelector("button")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders one card per entry and shows preview body without clicking", async () => {
    const mounted = await mountLabel([
      { header: "Quoted text", body: "first quoted body" },
      { header: "Quoted code (python)", body: "def greet():\n  print('hi')" },
      { header: "Quoted diff (server.ts)", body: "--- a/server.ts\n+++ b/server.ts" },
    ]);

    try {
      expect(mounted.host.querySelectorAll("button")).toHaveLength(3);

      const text = mounted.host.textContent ?? "";
      expect(text).toContain("first quoted body");
      expect(text).toContain("def greet():");
      expect(text).toContain("--- a/server.ts");
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles aria-expanded when the header is clicked", async () => {
    const mounted = await mountLabel([{ header: "Quoted text", body: "hello world" }]);

    try {
      const button = page.getByRole("button", { name: /Quoted text/ });
      const element = button.element() as HTMLButtonElement;

      expect(element.getAttribute("aria-expanded")).toBe("false");

      await button.click();
      expect(element.getAttribute("aria-expanded")).toBe("true");

      await button.click();
      expect(element.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the violet accent for text and code entries", async () => {
    const mounted = await mountLabel([
      { header: "Quoted text", body: "plain text" },
      { header: "Quoted code (ts)", body: "const x = 1" },
    ]);

    try {
      const violetCards = mounted.host.querySelectorAll("div[class*='violet']");
      expect(violetCards.length).toBeGreaterThanOrEqual(2);

      const emeraldCards = mounted.host.querySelectorAll("div[class*='emerald']");
      expect(emeraldCards.length).toBe(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the emerald accent only for diff entries", async () => {
    const mounted = await mountLabel([
      { header: "Quoted text", body: "plain text" },
      { header: "Quoted diff (foo.ts)", body: "--- a\n+++ b" },
    ]);

    try {
      const emeraldCards = mounted.host.querySelectorAll("div[class*='emerald']");
      expect(emeraldCards.length).toBeGreaterThanOrEqual(1);

      const violetCards = mounted.host.querySelectorAll("div[class*='violet']");
      expect(violetCards.length).toBeGreaterThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });
});

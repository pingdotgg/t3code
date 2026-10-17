// @vitest-environment jsdom

import type { ConfirmDialogOptions } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { requestConfirmDialog, resetConfirmDialogForTests } from "../confirmDialog";
import { ConfirmDialogHost } from "./ConfirmDialogHost";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ConfirmDialogHost />));
});

afterEach(async () => {
  resetConfirmDialogForTests();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openConfirm(options?: ConfirmDialogOptions) {
  await act(async () => {
    void requestConfirmDialog("Install update?", options);
  });
  // Base UI moves focus into the popup after it mounts.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  return document.activeElement?.textContent;
}

describe("ConfirmDialogHost initial focus", () => {
  it("keeps focus on Cancel unless the caller asks for Confirm", async () => {
    expect(await openConfirm()).toBe("Cancel");
  });

  it("focuses Confirm when the caller asks for it", async () => {
    expect(await openConfirm({ initialFocus: "confirm" })).toBe("Confirm");
  });

  it("keeps focus on Cancel for a destructive confirm, even when asked for Confirm", async () => {
    expect(await openConfirm({ variant: "destructive", initialFocus: "confirm" })).toBe("Cancel");
  });
});

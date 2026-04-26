import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerRuntimeModeControl } from "./ComposerRuntimeModeControl";

describe("ComposerRuntimeModeControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders access options and dispatches selection changes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onRuntimeModeChange = vi.fn();

    const screen = await render(
      <ComposerRuntimeModeControl
        runtimeMode="approval-required"
        runtimeModeLocked={false}
        onRuntimeModeChange={onRuntimeModeChange}
      />,
      { container: host },
    );

    await page.getByLabelText("Access mode").click();
    await page.getByText("Full access").click();

    expect(onRuntimeModeChange).toHaveBeenCalledWith("full-access");

    await screen.unmount();
    host.remove();
  });

  it("shows disabled-state copy when access is locked", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <ComposerRuntimeModeControl
        runtimeMode="approval-required"
        runtimeModeLocked
        runtimeModeLockReason="ASK mode locks access to Supervised."
        onRuntimeModeChange={vi.fn()}
      />,
      { container: host },
    );

    await page.getByLabelText("Access mode").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Auto-accept edits");
      expect(text).toContain("Full access");
      expect(text).toContain("Unavailable in ASK mode.");
    });

    await screen.unmount();
    host.remove();
  });
});

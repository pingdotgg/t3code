import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  finishRelayClientInstall,
  readRelayClientInstallDialogState,
  reportRelayClientInstallProgress,
  requestRelayClientInstallConfirmation,
  resetRelayClientInstallDialogForTests,
} from "../../cloud/relayClientInstallDialog";
import { RelayClientInstallDialog } from "./RelayClientInstallDialog";

describe("RelayClientInstallDialog", () => {
  beforeEach(() => {
    resetRelayClientInstallDialogForTests();
  });

  it("confirms installation and renders streamed progress", async () => {
    render(<RelayClientInstallDialog />);
    const confirmation = requestRelayClientInstallConfirmation("2026.5.2");

    await expect.element(page.getByText("Install relay client?")).toBeInTheDocument();
    await expect.element(page.getByText(/version 2026\.5\.2 locally/)).toBeInTheDocument();

    await page.getByRole("button", { name: "Download and install" }).click();
    await expect(confirmation).resolves.toBe(true);
    await expect
      .element(page.getByRole("heading", { name: "Installing relay client" }))
      .toBeInTheDocument();

    reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });
    await expect.element(page.getByText("Downloading relay client")).toBeInTheDocument();
    await expect
      .element(page.getByRole("progressbar", { name: "Relay client installation progress" }))
      .toHaveAttribute("value", "3");

    finishRelayClientInstall();
    expect(readRelayClientInstallDialogState().status).toBe("closing");
    await expect
      .element(page.getByRole("heading", { name: "Installing relay client" }))
      .not.toBeInTheDocument();
    expect(readRelayClientInstallDialogState()).toEqual({ status: "idle" });
  });
});

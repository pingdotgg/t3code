// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DeviceHostDiagnostics } from "./DeviceHostDiagnostics";

const hosts = [
  { id: "local", label: "Windows Desktop" },
  { id: "remote", label: "MacBook Pro" },
];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ready device host diagnostics", () => {
  it("keeps warnings paired with their host and clears recovered warnings", async () => {
    await act(() =>
      root.render(
        <DeviceHostDiagnostics
          hosts={hosts}
          hostStatuses={{
            remote: { status: "ready", detail: "iOS discovery failed." },
            local: { status: "ready", detail: "Android discovery failed." },
          }}
        />,
      ),
    );
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "Windows Desktop: Android discovery failed.",
      "MacBook Pro: iOS discovery failed.",
    ]);

    await act(() =>
      root.render(
        <DeviceHostDiagnostics
          hosts={hosts}
          hostStatuses={{ local: { status: "ready" }, remote: { status: "ready" } }}
        />,
      ),
    );
    expect(container.textContent).toBe("");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("omits unselected, unknown, failed and busy hosts", async () => {
    for (const status of ["disabled", "idle", "installing", "starting", "failed"] as const) {
      await act(() =>
        root.render(
          <DeviceHostDiagnostics
            hosts={[hosts[0]!]}
            hostStatuses={{
              local: { status, detail: "Handled by the host status UI." },
              remote: { status: "ready", detail: "Other host warning." },
              unknown: { status: "ready", detail: "Unknown host warning." },
            }}
          />,
        ),
      );
      expect(container.textContent).toBe("");
    }
  });
});

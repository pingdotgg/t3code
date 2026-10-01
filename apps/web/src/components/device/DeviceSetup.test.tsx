import { EnvironmentId, type DeviceServiceState } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// toJSON() is a plain props/children tree, but JSON.stringify chokes on it once
// React attaches fiber-internal fields; walk only type/children ourselves instead.
function renderedText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  return (node.children ?? []).map(renderedText).join(" ");
}

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/device", () => ({ deviceEnvironment: { configure: "configure", list: "list" } }));
vi.mock("~/components/ui/wizard", () => ({
  WizardHeader: ({ children }: { children?: ReactNode }) => children ?? null,
  WizardPanel: ({ children }: { children?: ReactNode }) => children ?? null,
  WizardFooter: ({ children }: { children?: ReactNode }) => children ?? null,
  WizardSteps: () => null,
}));
vi.mock("~/components/ui/dialog", () => ({ DialogClose: "button" }));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/switch", () => ({ Switch: "input" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));

import { DeviceSetup } from "./DeviceSetup";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const androidReason =
  "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.";

// A local host whose hub was just enabled, but no platform toolchain is available at all
// (the scenario from the bug report: Linux without a complete Android SDK, no Xcode).
const unsupportedLocalHostState: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      hubInstalled: true,
      agentDeviceInstalled: false,
      platforms: [
        { platform: "ios", available: false, reason: "iOS Simulators need macOS with Xcode." },
        { platform: "android", available: false, reason: androidReason },
      ],
    },
  ],
  // readinessIfSupported returns null for a host with no available platform, so
  // configure() leaves hostStatus "idle" instead of "ready" or "failed".
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

describe("DeviceSetup first step with no available local platform", () => {
  it("explains why setup cannot proceed instead of leaving Continue unexplained", async () => {
    await act(() => {
      renderer = create(
        <DeviceSetup environmentId={EnvironmentId.make("environment-1")} state={unsupportedLocalHostState} />,
      );
    });
    const rendered = renderedText(renderer!.toJSON());
    expect(rendered).toContain(androidReason);
  });
});

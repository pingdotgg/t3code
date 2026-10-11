// @vitest-environment jsdom

import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({ hash: "", state: {} }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "primary-settings",
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(["primary-settings"]),
}));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettingsAvailable: () => true }));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./useScopedSettings", () => ({
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({ useOptionalSettingsScope: () => null }));

import { Tooltip, TooltipPopup } from "../ui/tooltip";
import { SettingInheritance } from "./SettingInheritance";
import { DiagnosticsTooltip, DiagnosticsTooltips } from "./DiagnosticsTooltip";
import { SettingsPageContainer } from "./settingsLayout";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("settings shared popover routing", () => {
  it("keeps inheritance tooltips connected beneath another tooltip root", async () => {
    await act(async () => {
      root.render(
        <SettingsPageContainer>
          <Tooltip>
            <SettingInheritance
              state="default"
              summary="Built-in default"
              targets={[
                {
                  environmentId: EnvironmentId.make("primary-settings"),
                  label: "Test environment",
                  projectId: null,
                  ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null),
                },
              ]}
              environments={[]}
              keys={["defaultAutoPull"]}
            />
            <TooltipPopup>Other tooltip content</TooltipPopup>
          </Tooltip>
        </SettingsPageContainer>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (!trigger) throw new Error("Missing inheritance trigger");

    await act(async () => trigger.focus());

    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "Built-in default",
    );
  });

  it("shows Diagnostics content inside the page's inheritance provider", async () => {
    await act(async () => {
      root.render(
        <DiagnosticsTooltips>
          <SettingsPageContainer>
            <DiagnosticsTooltip tooltip="CPU used by the server process">
              Server CPU
            </DiagnosticsTooltip>
          </SettingsPageContainer>
        </DiagnosticsTooltips>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("button");
    if (!trigger) throw new Error("Missing Diagnostics tooltip trigger");

    await act(async () => trigger.focus());

    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "CPU used by the server process",
    );
  });
});

describe("settings shared popovers close with their trigger", () => {
  it("closes the Diagnostics tooltip when its row disappears", async () => {
    const render = (shown: boolean) => (
      <DiagnosticsTooltips>
        {shown ? (
          <DiagnosticsTooltip tooltip="node provider.js">Provider process</DiagnosticsTooltip>
        ) : null}
        <DiagnosticsTooltip tooltip="CPU used by the server process">Server CPU</DiagnosticsTooltip>
      </DiagnosticsTooltips>
    );
    await act(async () => root.render(render(true)));
    await act(async () => container.querySelector<HTMLButtonElement>("button")?.focus());
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "node provider.js",
    );

    await act(async () => root.render(render(false)));

    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  });

  it("keeps the Diagnostics tooltip open when another row disappears", async () => {
    const render = (shown: boolean) => (
      <DiagnosticsTooltips>
        <DiagnosticsTooltip tooltip="CPU used by the server process">Server CPU</DiagnosticsTooltip>
        {shown ? (
          <DiagnosticsTooltip tooltip="node provider.js">Provider process</DiagnosticsTooltip>
        ) : null}
      </DiagnosticsTooltips>
    );
    await act(async () => root.render(render(true)));
    await act(async () => container.querySelector<HTMLButtonElement>("button")?.focus());

    await act(async () => root.render(render(false)));

    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "CPU used by the server process",
    );
  });

  it("closes inheritance details when the setting has no targets left", async () => {
    const environmentId = EnvironmentId.make("primary-settings");
    const render = (connected: boolean) => (
      <SettingsPageContainer>
        <SettingInheritance
          state="default"
          summary="Built-in default"
          targets={
            connected
              ? [
                  {
                    environmentId,
                    label: "Test environment",
                    projectId: null,
                    ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null),
                  },
                ]
              : []
          }
          environments={[
            {
              environmentId,
              serverConfig: {
                settings: DEFAULT_SERVER_SETTINGS,
                environment: { platform: "linux" },
              } as never,
            },
          ]}
          keys={["defaultAutoPull"]}
        />
      </SettingsPageContainer>
    );
    await act(async () => root.render(render(true)));
    await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
    expect(document.querySelector('[data-slot="popover-popup"]')).not.toBeNull();

    await act(async () => root.render(render(false)));

    expect(container.querySelector("button")).toBeNull();
    expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
  });
});

import "../../index.css";

import { DEFAULT_SERVER_SETTINGS, type NativeApi, type ServerConfig } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { resetNativeApiForTests } from "../../nativeApi.testing";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetAppAtomRegistryForTests } from "../../rpc/atomRegistry.testing";
import { startServerStateSync } from "../../rpc/serverState";
import { GeneralSettingsPanel } from "./SettingsPanels";

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function seedServerConfig(config: ServerConfig) {
  return startServerStateSync({
    getConfig: () => Promise.resolve(config),
    subscribeConfig: (listener) => {
      listener({ version: 1, type: "snapshot", config });
      return () => undefined;
    },
    subscribeLifecycle: () => () => undefined,
  });
}

describe("GeneralSettingsPanel observability", () => {
  beforeEach(() => {
    resetAppAtomRegistryForTests();
    resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetAppAtomRegistryForTests();
    resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("shows diagnostics inside About with a single logs-folder action", async () => {
    const stopServerStateSync = seedServerConfig(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    stopServerStateSync();

    await expect.element(page.getByText("About")).toBeInTheDocument();
    await expect.element(page.getByText("Diagnostics")).toBeInTheDocument();
    await expect.element(page.getByText("Open logs folder")).toBeInTheDocument();
    await expect
      .element(page.getByText("/repo/project/.t3/logs", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<NativeApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      shell: {
        openInEditor,
      },
    } as unknown as NativeApi;

    const stopServerStateSync = seedServerConfig(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    stopServerStateSync();

    const openLogsButton = page.getByText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.t3/logs", "cursor");
  });
});

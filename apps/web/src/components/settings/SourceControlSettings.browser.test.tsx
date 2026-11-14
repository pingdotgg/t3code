import { EnvironmentId, type SourceControlDiscoveryResult } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Option from "effect/Option";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import "../../index.css";
import { act, render } from "../../../test/render";

const environmentId = EnvironmentId.make("env-local");
const github = sourceControlClients.definitions.find((definition) => definition.label === "GitHub");
if (github?.credentials === undefined) {
  throw new Error("GitHub source control definition is missing credentials");
}

const state = vi.hoisted(() => ({
  pending: false,
  refresh: vi.fn(),
  signedIn: false,
  empty: false,
}));

const discovered = (): SourceControlDiscoveryResult => ({
  versionControlSystems: [
    {
      kind: "git",
      implemented: true,
      label: "Git",
      executable: "git",
      status: "available",
      version: Option.some("2.51.0"),
      installHint: "Install Git.",
      detail: Option.none(),
    },
  ],
  sourceControlProviders: [
    {
      kind: github.kind,
      label: github.label,
      executable: "gh",
      status: "available",
      version: Option.some("2.103.3"),
      installHint: "Install the GitHub CLI.",
      detail: Option.none(),
      auth: {
        status: "unauthenticated",
        account: Option.none(),
        host: Option.none(),
        detail: Option.none(),
        accounts: state.signedIn
          ? [{ host: "github.com", account: "octocat", active: true, authenticated: true }]
          : [],
      },
    },
  ],
});

const discovery = (): SourceControlDiscoveryResult =>
  state.empty ? { versionControlSystems: [], sourceControlProviders: [] } : discovered();

vi.mock(import("./ProjectDefaultsSettings"), () => ({
  ProjectDefaultsSettings: () => <span />,
}));
vi.mock(import("./SourceControlWritingSettings"), () => ({
  SourceControlWritingSettingsSection: () => <span />,
}));
vi.mock(import("./SourceControlTokenSettings"), () => ({
  SourceControlTokenSettings: () => (
    <p className="text-xs text-muted-foreground">
      A token saved here is used before GH_TOKEN and the gh login.
    </p>
  ),
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentIds: [environmentId] },
    environment: {
      environmentId,
      label: "This machine",
      connection: { phase: "connected" },
    },
    connectedEnvironments: [{ environmentId }],
  })) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: discovery(),
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: state.pending,
    isSuccess: true,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => ({ hosts: {} })) as never,
}));

import { SourceControlSettingsPanel } from "./SourceControlSettings";

const content = () => (
  <StrictMode>
    <SourceControlSettingsPanel />
  </StrictMode>
);

const buttonByLabel = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );

const rescanButtons = (root: ParentNode) =>
  [...root.querySelectorAll("button")].filter((button) => button.textContent?.includes("Rescan"));

const inlineRescan = (root: ParentNode) =>
  rescanButtons(root).find(
    (button) => button.getAttribute("aria-label") !== "Rescan server environment",
  );

async function setup(overrides?: {
  readonly pending?: boolean;
  readonly signedIn?: boolean;
  readonly empty?: boolean;
}) {
  state.pending = overrides?.pending ?? false;
  state.signedIn = overrides?.signedIn ?? false;
  state.empty = overrides?.empty ?? false;
  state.refresh.mockReset();
  return render(content());
}

describe("source control rescan", () => {
  it("names the rescan step beside the CLI sign-in instruction", async () => {
    await using screen = await setup();

    const header = buttonByLabel(screen.container, "Rescan server environment");
    expect(header?.textContent).toContain("Rescan");
    await act(() => {
      buttonByLabel(screen.container, "Toggle GitHub details")?.click();
    });
    expect(screen.container.textContent).toContain(
      "Run gh auth login on the server host, then rescan to choose accounts here. A token saved above is an alternative.",
    );
    const inline = inlineRescan(screen.container);
    expect(inline).toBeDefined();
    await act(() => {
      inline?.click();
      header?.click();
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("leaves the account list in place once a CLI login is already listed", async () => {
    await using screen = await setup({ signedIn: true });

    await act(() => {
      buttonByLabel(screen.container, "Toggle GitHub details")?.click();
    });
    expect(screen.container.textContent).toContain("Signed in as");
    expect(screen.container.textContent).not.toContain("No GitHub CLI login");
    expect(inlineRescan(screen.container)).toBeUndefined();
    expect(buttonByLabel(screen.container, "Rescan server environment")).toBeDefined();
  });

  it("uses the same Rescan label when nothing has been detected yet", async () => {
    await using screen = await setup({ empty: true });

    expect(screen.container.textContent).toContain("then rescan");
    expect(rescanButtons(screen.container).map((button) => button.textContent?.trim())).toEqual([
      "Rescan",
    ]);
  });

  it("disables rescan while a scan is already running", async () => {
    await using screen = await setup({ pending: true });

    expect(buttonByLabel(screen.container, "Rescan server environment")?.disabled).toBe(true);
    await act(() => {
      buttonByLabel(screen.container, "Toggle GitHub details")?.click();
    });
    expect(inlineRescan(screen.container)?.disabled).toBe(true);
    expect(state.refresh).not.toHaveBeenCalled();
  });
});

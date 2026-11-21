import {
  SourceControlProviderKind,
  type GitHubAccountRules,
  type SourceControlDiscoveryResult,
} from "@lathe/contracts";
import * as Option from "effect/Option";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render as renderScreen } from "../../../test/render";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  rules: [] as GitHubAccountRules,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
  writeTargets: [] as ReadonlyArray<string>,
  environments: [] as ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly connection: { readonly phase: "connected" };
    readonly serverConfig: {
      readonly settings: { readonly gitHubAccountRules: GitHubAccountRules };
      readonly environment: { readonly capabilities: { readonly gitHubAccountRouting?: boolean } };
    };
  }>,
}));

const machine = (
  label: string,
  rules: GitHubAccountRules,
  supported = true,
): (typeof state.environments)[number] => ({
  environmentId: label,
  label,
  connection: { phase: "connected" },
  serverConfig: {
    settings: { gitHubAccountRules: rules },
    environment: { capabilities: supported ? { gitHubAccountRouting: true } : {} },
  },
});

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useUpdateScopedSettingsOn: ((environments: ReadonlyArray<{ readonly label: string }>) => {
    state.writeTargets = environments.map((environment) => environment.label);
    return state.updateSettings;
  }) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    environment: state.environments[0] ?? null,
    connectedEnvironments: state.environments,
    targets: [],
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <div>
      {headerAction}
      {children}
    </div>
  )) as never,
  SettingsRow: (({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  )) as never,
}));

import { GitHubAccountRulesSettings } from "./GitHubAccountRulesSettings";

function discovery(logins: ReadonlyArray<string>): SourceControlDiscoveryResult {
  return {
    versionControlSystems: [],
    sourceControlProviders: [
      {
        kind: SourceControlProviderKind.make("github"),
        label: "GitHub",
        status: "available",
        version: Option.none(),
        installHint: "",
        detail: Option.none(),
        auth: {
          status: "authenticated",
          account: Option.some(logins[0] ?? "nobody"),
          host: Option.some("github.com"),
          detail: Option.none(),
          accounts: logins.map((login, index) => ({
            host: "github.com",
            account: login,
            active: index === 0,
            authenticated: true,
          })),
        },
      },
    ],
  };
}

function setup() {
  state.rules = [{ host: "github.com", owner: "acme", login: "personal" }];
  state.environments = [machine("Mac", state.rules)];
  state.writeTargets = [];
  state.updateSettings.mockReset();
}

function render(logins: ReadonlyArray<string>) {
  return renderScreen(
    <StrictMode>
      <GitHubAccountRulesSettings discovery={discovery(logins)} />
    </StrictMode>,
  );
}

const ownerInputs = () => page.getByRole("textbox", { name: "Repository owner pattern" });

async function commitOwner(index: number, value: string) {
  const input = ownerInputs().nth(index);
  await input.fill(value);
  await act(() => (input.element() as HTMLInputElement).blur());
}

describe("GitHubAccountRulesSettings", () => {
  it("adds a rule and writes the whole list", async () => {
    setup();
    await using _screen = await render(["personal", "work"]);
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect.poll(() => ownerInputs().all().length).toBe(2);

    await commitOwner(1, "bad owner");
    expect(state.updateSettings).not.toHaveBeenCalled();

    await commitOwner(1, " geico-* ");
    expect(state.updateSettings).toHaveBeenCalledWith({
      gitHubAccountRules: [
        { host: "github.com", owner: "acme", login: "personal" },
        { host: "github.com", owner: "geico-*", login: "personal" },
      ],
    });
  });

  it("moves a rule down", async () => {
    setup();
    state.rules = [
      { host: "github.com", owner: "acme", login: "personal" },
      { host: "github.com", owner: "geico-*", login: "work" },
    ];
    state.environments = [machine("Mac", state.rules)];
    await using _screen = await render(["personal", "work"]);

    await expect.element(page.getByRole("button", { name: "Move rule 2 down" })).toBeDisabled();
    await page.getByRole("button", { name: "Move rule 1 down" }).click();

    expect(state.updateSettings).toHaveBeenCalledWith({
      gitHubAccountRules: [
        { host: "github.com", owner: "geico-*", login: "work" },
        { host: "github.com", owner: "acme", login: "personal" },
      ],
    });
  });

  it("hides the editor with one account", async () => {
    setup();
    await using screen = await render(["personal"]);

    await expect.element(screen.getByText(/second GitHub account/)).toBeInTheDocument();
    expect(screen.getByRole("button").all()).toHaveLength(0);
    expect(ownerInputs().all()).toHaveLength(0);
  });

  it("edits every machine that supports rules at All environments and names the rest", async () => {
    setup();
    state.environments = [
      machine("Mac", state.rules),
      machine("hephaestus", state.rules),
      machine("incus", [], false),
    ];
    await using screen = await render(["personal", "work"]);

    await expect
      .element(screen.getByText(/Rules cover every machine unless you pick one/))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText(/incus run a server without account rules/))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Remove rule 1" }).click();

    expect(state.writeTargets).toEqual(["Mac", "hephaestus"]);
    expect(state.updateSettings).toHaveBeenCalledWith({ gitHubAccountRules: [] });
  });

  it("offers to apply one machine's rules everywhere when they differ", async () => {
    setup();
    state.environments = [
      machine("Mac", state.rules),
      machine("hephaestus", [{ host: "github.com", owner: "geico-*", login: "work" }]),
    ];
    await using _screen = await render(["personal", "work"]);

    await page.getByRole("button", { name: "Use Mac's rules everywhere" }).click();

    expect(ownerInputs().all()).toHaveLength(0);
    expect(state.updateSettings).toHaveBeenCalledWith({ gitHubAccountRules: state.rules });
  });

  it("asks for a server update when no selected machine supports rules", async () => {
    setup();
    state.environments = [machine("incus", [], false)];
    await using screen = await render(["personal", "work"]);

    await expect.element(screen.getByText(/newer server on incus/)).toBeInTheDocument();
    expect(ownerInputs().all()).toHaveLength(0);
  });
});

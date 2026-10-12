import type { ReactElement } from "react";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  type PluginInstallation,
  PluginInstallationId,
} from "@t3tools/contracts";
import {
  pluginSettingsReadOnly,
  resolvePluginManageAccess,
} from "@t3tools/client-runtime/state/pluginPresentation";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const update = vi.hoisted(() => vi.fn());

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    AsyncResult.success({
      _tag: "available",
      values: {
        installationId: "installation-1",
        values: [{ key: "endpoint", value: "https://saved.example.test" }],
        secrets: ["token"],
      },
    }),
}));
vi.mock("../../state/plugins", () => ({
  pluginSettingsEnvironment: { values: () => "values", update: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => update }));

import { PluginSettingsForm } from "./PluginSettingsForm";

const environmentId = EnvironmentId.make("remote");
const installation = {
  installationId: PluginInstallationId.make("installation-1"),
  manifest: {
    name: "Notifier",
    settings: [
      { type: "text", key: "endpoint", label: "Endpoint" },
      { type: "secret", key: "token", label: "API token" },
    ],
  },
} as unknown as PluginInstallation;

/** The form as a session with these scopes sees it, settled. */
function readOnlyFor(scopes: ReadonlyArray<string>) {
  return pluginSettingsReadOnly(
    resolvePluginManageAccess({
      session: { authenticated: true, scopes: scopes as never },
      isPending: false,
      hasError: false,
    }),
  );
}

function renderForm(readOnly: boolean) {
  hooks.beginRender();
  return PluginSettingsForm({ environmentId, installation, readOnly }) as ReactElement;
}

function find(tree: ReactElement, match: (props: Record<string, unknown>) => boolean) {
  const element = visitElements(tree, (candidate) => match(candidate.props));
  if (!element) throw new Error("Element not found");
  return element.props;
}

/** Edits the endpoint, then submits and presses Clear on the saved secret. */
async function editAndSave(readOnly: boolean) {
  (
    find(renderForm(readOnly), (props) => props.id === "plugin-setting-installation-1-endpoint")
      .onChange as (event: { target: { value: string } }) => void
  )({
    target: { value: "https://new.example.test" },
  });
  (
    find(renderForm(readOnly), (props) => typeof props.onSubmit === "function").onSubmit as (
      event: object,
    ) => void
  )({ preventDefault: () => undefined });
  (find(renderForm(readOnly), (props) => props.children === "Clear").onClick as () => void)();
  await Promise.resolve();
}

describe("PluginSettingsForm access", () => {
  beforeEach(() => {
    hooks.reset();
    update.mockReset().mockReturnValue(new Promise(() => undefined));
  });

  it("is read-only for a standard pairing and saves nothing by any path", async () => {
    const readOnly = readOnlyFor(AuthStandardClientScopes);
    expect(readOnly).toBe(true);
    await editAndSave(readOnly);
    expect(update).not.toHaveBeenCalled();
  });

  it("saves an administrative session's edit", async () => {
    const readOnly = readOnlyFor(AuthAdministrativeScopes);
    expect(readOnly).toBe(false);
    await editAndSave(readOnly);
    // The submit saves; the form then locks until it settles, so Clear waits.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      environmentId,
      input: {
        installationId: installation.installationId,
        changes: [{ key: "endpoint", value: "https://new.example.test" }],
      },
    });
  });
});

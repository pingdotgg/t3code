import { act, render as renderScreen, type Screen } from "../../../test/render";
import {
  AuthOrchestrationReadScope,
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
import { describe, expect, it, vi } from "vite-plus/test";
const update = vi.hoisted(() => vi.fn());
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
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
async function renderForm(screen: Screen, readOnly: boolean) {
  await act(
    async () =>
      await screen.rerender(
        <PluginSettingsForm
          environmentId={environmentId}
          installation={installation}
          readOnly={readOnly}
        />,
      ),
  );
}
/** Edits the endpoint, submits through the form, and presses the saved secret's Clear control. */
async function editAndSave(screen: Screen, readOnly: boolean) {
  await renderForm(screen, readOnly);
  const input = document.getElementById("plugin-setting-installation-1-endpoint")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "https://new.example.test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const clear = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Clear",
  )!;
  await act(async () => clear.click());
}
describe("PluginSettingsForm access", () => {
  it("is read-only for a pairing without management access and saves nothing by any path", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    const readOnly = readOnlyFor([AuthOrchestrationReadScope]);
    expect(readOnly).toBe(true);
    await editAndSave(screen, readOnly);
    expect(update).not.toHaveBeenCalled();
  });
  it("saves a standard session's edit", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    const readOnly = readOnlyFor(AuthStandardClientScopes);
    expect(readOnly).toBe(false);
    await editAndSave(screen, readOnly);
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
  it("preserves multiline text and replacement secrets through a save", async () => {
    using _setup = await setup();
    await using screen = await renderScreen(null, { router: false });
    await renderForm(screen, false);
    const values = [
      ["endpoint", '{\n  "endpoint": "https://example.test"\n}'],
      ["token", "-----BEGIN KEY-----\nprivate-data\n-----END KEY-----"],
    ] as const;
    for (const [key, value] of values) {
      const input = document.getElementById(`plugin-setting-installation-1-${key}`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () =>
      screen.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(update).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        installationId: installation.installationId,
        changes: values.map(([key, value]) => ({ key, value })),
      },
    });
  });
});

async function setup() {
  update.mockReset().mockReturnValue(new Promise(() => undefined));
  return { [Symbol.dispose]() {} };
}

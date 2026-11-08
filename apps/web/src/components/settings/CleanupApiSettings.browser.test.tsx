import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, SECRET_REDACTED } from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import * as Session from "../../state/session";
import * as Scope from "./SettingsScopeContext";
import * as Settings from "./useScopedSettings";
import { CleanupApiSettings } from "./CleanupApiSettings";

vi.mock(import("../../state/session"), { spy: true });
vi.mock(import("./SettingsScopeContext"), { spy: true });
vi.mock(import("./useScopedSettings"), { spy: true });

it("discards an unsaved key when switching environments", async () => {
  let environmentId = EnvironmentId.make("first");
  const connections = new Map(
    ["first", "second"].map((id) => {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(id),
        label: id,
        httpBaseUrl: window.location.origin,
        wsBaseUrl: "ws://localhost",
      });
      return [
        id,
        { ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null },
      ] as const;
    }),
  );
  const requests: string[] = [];
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.href);
    if (url.pathname === "/api/voice/cleanup/openai/models") {
      requests.push(url.pathname);
      return Promise.resolve(
        Response.json({ models: [{ id: "cleanup-model", name: "Cleanup model" }] }),
      );
    }
    return fetch(input, init);
  });
  const settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    speechPostProcessingProvider: "openai" as const,
    voiceApiCredentials: {
      ...DEFAULT_UNIFIED_SETTINGS.voiceApiCredentials,
      openaiPostProcessing: SECRET_REDACTED,
    },
  };
  const scope = () => {
    const environment = { environmentId, label: environmentId, serverConfig: { settings } };
    return {
      environment,
      connectedEnvironments: [environment],
      environments: [environment],
      scope: { kind: "environment", environmentIds: [environmentId] },
      targets: [],
      groups: [],
      search: {},
      target: null,
      singleEnvironment: true,
    } as never;
  };
  using _scope = vi.spyOn(Scope, "useSettingsScope").mockImplementation(scope);
  using _optionalScope = vi.spyOn(Scope, "useOptionalSettingsScope").mockImplementation(scope);
  using _settings = vi
    .spyOn(Settings, "useScopedSettings")
    .mockImplementation((() => settings) as never);
  using _allowed = vi.spyOn(Settings, "useScopedSettingsWriteAllowed").mockReturnValue(true);
  using _update = vi.spyOn(Settings, "useUpdateScopedSettings").mockReturnValue(vi.fn());
  using _prepared = vi
    .spyOn(Session, "usePreparedConnection")
    .mockImplementation(() => Option.fromNullishOr(connections.get(environmentId)));
  using _permission = vi.spyOn(Session, "useEnvironmentScope").mockReturnValue(true);
  using _permissions = vi
    .spyOn(Session, "useEnvironmentsWithScope")
    .mockImplementation(() => new Set([environmentId]));
  await using screen = await render(<CleanupApiSettings />);
  await expect
    .element(screen.getByText("1 models available. You can also enter any model ID above."))
    .toBeVisible();
  const key = screen.getByRole("textbox", { name: "OpenAI API (BYOK) cleanup API key" });
  await userEvent.fill(key, "unsaved-first-environment-key");
  await expect.element(screen.getByText("New key entered. Save it to use it.")).toBeVisible();
  expect(requests).toHaveLength(1);
  environmentId = EnvironmentId.make("second");
  await screen.rerender(<CleanupApiSettings />);
  await expect.element(key).toHaveValue("");
  await expect.element(screen.getByText("API key saved on second.")).toBeVisible();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
});

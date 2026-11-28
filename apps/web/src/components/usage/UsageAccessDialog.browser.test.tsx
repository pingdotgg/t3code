import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  mutateProviderInstance: vi.fn(),
  config: null as unknown,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => state.config) as never,
      mutateProviderInstance: "mutateProviderInstance" as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "mutateProviderInstance") => state[command]) as never,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { UsageAccessQuestion, type UsageAccessPrompt } from "./UsageAccessDialog";

const environmentId = EnvironmentId.make("primary");
const prompt = (driver: string): UsageAccessPrompt => ({
  environmentId,
  environmentLabel: "cups",
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
});

it("says what each agent's access reads and saves only the agents left on", async () => {
  state.config = Atom.make({ settings: { providerInstances: {} } });
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsageAccessQuestion prompts={[prompt("claudeAgent"), prompt("codex")]} />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("Session history and sign-in")).toBeVisible();
  await expect.element(screen.getByText("Session history", { exact: true })).toBeVisible();

  await screen.getByRole("switch", { name: /Codex/ }).click();
  await screen.getByRole("button", { name: "Allow", exact: true }).click();
  await vi.waitFor(() => expect(state.mutateProviderInstance).toHaveBeenCalledTimes(2));

  const saved = state.mutateProviderInstance.mock.calls.map(
    ([call]) => call.input.providerInstanceMutation.instance,
  );
  expect(saved).toEqual([
    { driver: "claudeAgent", usageAccess: "allowed" },
    { driver: "codex", usageAccess: "denied" },
  ]);
});

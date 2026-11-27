import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

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
import { UsageAccessOverlay, type UsageAccessPrompt } from "./UsageAccessDialog";

const environmentId = EnvironmentId.make("primary");
const prompt = (driver: string, path: string): UsageAccessPrompt => ({
  environmentId,
  environmentLabel: "cups",
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  paths: [path],
});

it("says what each agent's access reads and saves only the agents left checked", async () => {
  state.config = Atom.make({ settings: { providerInstances: {} } });
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsageAccessOverlay
        prompts={[
          prompt("claudeAgent", "/home/me/.claude/projects"),
          prompt("codex", "/home/me/.codex/sessions"),
        ]}
      />
    </RegistryContext.Provider>,
  );
  const text = () => screen.container.textContent ?? "";
  expect(text()).toContain(
    "Reads its session history at /home/me/.claude/projects, and its sign-in to ask Anthropic for your reset credits.",
  );
  expect(text()).toContain("Reads its session history at /home/me/.codex/sessions.");

  const [, codexCheckbox] = [...screen.container.querySelectorAll<HTMLElement>("[role=checkbox]")];
  await act(async () => codexCheckbox?.click());
  const allow = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Allow",
  );
  await act(async () => allow?.click());

  const saved = state.mutateProviderInstance.mock.calls.map(
    ([call]) => call.input.providerInstanceMutation.instance,
  );
  expect(saved).toEqual([
    { driver: "claudeAgent", usageAccess: "allowed" },
    { driver: "codex", usageAccess: "denied" },
  ]);
});

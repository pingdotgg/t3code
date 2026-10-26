import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  result: null as { readonly agents: ReadonlyArray<AcpRegistrySearchAgent> } | null,
  error: null as string | null,
  isPending: false,
  canManage: true,
  refresh: vi.fn(),
  search: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      searchAcpRegistry: ((input: unknown) => {
        state.search(input);
        return "search";
      }) as never,
    },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canManage,
  readEnvironmentScope: () => state.canManage,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.result,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.prepare) as never,
}));

import { AcpRegistrySearchStep, useAcpRegistrySearch } from "./AcpRegistrySearchStep";

const environmentId = EnvironmentId.make("remote-device");
const gemini: AcpRegistrySearchAgent = {
  id: "gemini",
  name: "Gemini CLI",
  version: "1.2.3",
  description: "Google's agent",
  authors: ["Google <gemini-cli@google.com>", "Contributor"],
  license: "Apache-2.0",
  website: "https://example.com/docs",
  repository: "https://example.com/source",
  icon: null,
  distribution: "npx",
  integrity: "registry",
};

function Step({
  configured = false,
  onPrepared = vi.fn(),
}: {
  readonly configured?: boolean;
  readonly onPrepared?: (agent: AcpRegistrySearchAgent) => void;
}) {
  const registry = useAcpRegistrySearch(environmentId, true);
  return (
    <AcpRegistrySearchStep
      environmentId={environmentId}
      registry={registry}
      providerInstances={
        configured
          ? {
              acpRegistry_gemini: {
                driver: ProviderDriverKind.make("acpRegistry"),
                config: { agentId: "gemini" },
              },
            }
          : {}
      }
      onPrepared={onPrepared}
      onManualConfiguration={vi.fn()}
    />
  );
}

function setup() {
  state.canManage = true;
  state.result = null;
  state.error = null;
  state.isPending = false;
  state.refresh.mockReset();
  state.search.mockReset();
  state.prepare.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { agentId: "gemini", version: "1.2.3", distribution: "npx", prepared: true },
  });
}

it("rechecks the grant before preparing an agent", async () => {
  setup();
  state.result = { agents: [gemini] };
  const onPrepared = vi.fn();
  await using _screen = await render(<Step onPrepared={onPrepared} />);
  state.canManage = false;

  await page.getByRole("button", { name: "Add Gemini CLI" }).click();

  expect(state.prepare).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
});

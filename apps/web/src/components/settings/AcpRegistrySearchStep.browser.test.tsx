import {
  AcpRegistrySearchInput,
  EnvironmentId,
  ProviderDriverKind,
  type AcpRegistrySearchAgent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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

it("bounds pasted registry searches before debounce and submission", async () => {
  setup();
  const isSearchInput = Schema.is(AcpRegistrySearchInput);
  state.search.mockImplementation(({ input }: { readonly input: unknown }) => {
    state.error = isSearchInput(input) ? null : "Invalid registry search query";
    state.result = { agents: [] };
  });
  await using screen = await render(<Step />);
  const searchbox = screen.getByRole("searchbox", { name: "Search ACP Registry" });

  await searchbox.fill("agent".repeat(26));
  await vi.waitFor(() => {
    expect(state.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "agent".repeat(24) },
    });
  });
  await userEvent.keyboard("{Enter}");
  expect(state.refresh).toHaveBeenCalledTimes(1);

  await expect.element(searchbox).toHaveValue("agent".repeat(24));
  await expect.element(screen.getByText("No compatible agents found")).toBeVisible();
  await expect.element(screen.getByText("Invalid registry search query")).not.toBeInTheDocument();
});

it("leaves out Registry agents that T3 Code supports as their own providers", async () => {
  setup();
  state.result = { agents: [gemini, { ...gemini, id: "codex-acp", name: "Codex" }] };
  await using _screen = await render(<Step />);

  expect(page.getByRole("button", { name: "Add Gemini CLI" }).query()).not.toBeNull();
  expect(page.getByRole("button", { name: "Add Codex" }).query()).toBeNull();
});

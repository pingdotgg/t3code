import {
  ACP_REGISTRY_MAX_AGENTS,
  EnvironmentId,
  ProviderDriverKind,
  type AcpRegistrySearchAgent,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { Dialog, DialogPopup } from "../ui/dialog";

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
});

it("leaves out Registry agents that T3 Code supports as their own providers", async () => {
  setup();
  state.result = { agents: [gemini, { ...gemini, id: "codex-acp", name: "Codex" }] };
  await using _screen = await render(<Step />);

  expect(page.getByRole("button", { name: "Add Gemini CLI" }).query()).not.toBeNull();
  expect(page.getByRole("button", { name: "Add Codex" }).query()).toBeNull();
});

it("Escape in the search clears it without closing Add provider", async () => {
  setup();
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <Step />
      </DialogPopup>
    </Dialog>,
  );
  const search = page.getByRole("searchbox", { name: "Search ACP Registry" });
  await userEvent.fill(search, "gemini");
  await vi.waitFor(() => {
    expect(state.search).toHaveBeenLastCalledWith({ environmentId, input: { query: "gemini" } });
  });
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    // Safari ends the composition just before the Escape keydown.
    await act(() => {
      search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      search
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true }),
        );
    });
    await expect.element(search).toHaveValue("gemini");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  // The cleared search lists the whole Registry right away, without the typing debounce.
  expect(state.search).toHaveBeenLastCalledWith({
    environmentId,
    input: { query: "", limit: ACP_REGISTRY_MAX_AGENTS },
  });
  // Holding Escape repeats the keydown, which must not also close the dialog.
  await act(() => {
    search.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([false]);
});

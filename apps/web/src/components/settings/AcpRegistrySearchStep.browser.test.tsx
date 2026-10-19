import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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

import { AcpRegistrySearchStep } from "./AcpRegistrySearchStep";

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

const roots: Root[] = [];
let root: Root;

function render(options?: {
  readonly configured?: boolean;
  readonly onPrepared?: (agent: AcpRegistrySearchAgent) => void;
}) {
  return act(async () =>
    root.render(
      <AcpRegistrySearchStep
        environmentId={environmentId}
        providerInstances={
          options?.configured
            ? {
                acpRegistry_gemini: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  config: { agentId: "gemini" },
                },
              }
            : {}
        }
        onPrepared={options?.onPrepared ?? vi.fn()}
        onManualConfiguration={vi.fn()}
      />,
    ),
  );
}

const searchBox = () => page.getByRole("searchbox", { name: "Search ACP Registry" });
const lastQuery = () =>
  (state.search.mock.lastCall?.[0] as { input: { query: string } } | undefined)?.input.query;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
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
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  roots.push(root);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const mounted of roots.splice(0)) await act(async () => mounted.unmount());
  document.body.replaceChildren();
});

it("loads the catalog immediately and searches only after typing settles", async () => {
  await render();
  expect(state.search).toHaveBeenLastCalledWith({ environmentId, input: { query: "" } });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await userEvent.fill(searchBox(), "  Gemini  ");
  await act(async () => vi.advanceTimersByTime(200));
  await userEvent.fill(searchBox(), "  Gemini CLI  ");
  await act(async () => vi.advanceTimersByTime(299));
  expect(lastQuery()).toBe("");
  await act(async () => vi.advanceTimersByTime(1));
  expect(lastQuery()).toBe("Gemini CLI");

  await userEvent.clear(searchBox());
  await act(async () => vi.advanceTimersByTime(300));
  expect(lastQuery()).toBe("");
});

it("shows the loading, error, and empty states", async () => {
  state.isPending = true;
  await render();
  await expect.element(page.getByText("Searching the registry...")).toBeVisible();

  state.isPending = false;
  state.error = "Registry unavailable.";
  await render();
  await expect.element(page.getByText("Registry unavailable.")).toBeVisible();

  state.error = null;
  state.result = { agents: [] };
  await render();
  await expect.element(page.getByText("No compatible agents found")).toBeVisible();
});

it("submits a typed query at once and refreshes when the same query is submitted again", async () => {
  await render();
  await userEvent.fill(searchBox(), "Codex");
  await userEvent.keyboard("{Enter}");
  expect(lastQuery()).toBe("Codex");
  expect(state.refresh).not.toHaveBeenCalled();

  state.result = { agents: [gemini] };
  await render();
  await userEvent.click(searchBox());
  await userEvent.keyboard("{Enter}");
  expect(state.refresh).toHaveBeenCalledOnce();

  state.isPending = true;
  await render();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Refreshing ACP Registry results." }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Add Gemini CLI" })).toBeVisible();
});

it("prepares a result before handing it back to the wizard", async () => {
  state.prepare.mockResolvedValueOnce({
    _tag: "Success",
    value: { agentId: "gemini", version: "2.0.0", distribution: "binary", prepared: true },
  });
  state.result = { agents: [gemini] };
  const onPrepared = vi.fn();
  await render({ onPrepared });

  await page.getByRole("button", { name: "Add Gemini CLI" }).click();

  expect(state.prepare).toHaveBeenCalledWith({ environmentId, input: { agentId: "gemini" } });
  await vi.waitFor(() =>
    expect(onPrepared).toHaveBeenCalledWith({
      ...gemini,
      version: "2.0.0",
      distribution: "binary",
    }),
  );
});

it("shows progress, locks the step while an agent prepares, and reports a failure", async () => {
  const pending = deferred<unknown>();
  state.prepare.mockReturnValueOnce(pending.promise);
  state.result = { agents: [{ ...gemini, distribution: "binary" }] };
  await render();

  await page.getByRole("button", { name: "Add Gemini CLI" }).click();
  await expect.element(page.getByRole("button", { name: "Downloading Gemini CLI" })).toBeDisabled();
  await expect.element(searchBox()).toBeDisabled();

  await act(async () =>
    pending.resolve({ _tag: "Failure", cause: Cause.fail(new Error("Registry download failed.")) }),
  );
  await expect.element(page.getByText("Registry download failed.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add Gemini CLI" })).toBeEnabled();
});

it("rechecks the grant before preparing an agent", async () => {
  state.result = { agents: [gemini] };
  const onPrepared = vi.fn();
  await render({ onPrepared });
  state.canManage = false;

  await page.getByRole("button", { name: "Add Gemini CLI" }).click();

  expect(state.prepare).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
});

it("ignores prepare completion after unmount", async () => {
  const pending = deferred<unknown>();
  state.prepare.mockReturnValueOnce(pending.promise);
  state.result = { agents: [gemini] };
  const onPrepared = vi.fn();
  await render({ onPrepared });

  await page.getByRole("button", { name: "Add Gemini CLI" }).click();
  await act(async () => root.unmount());
  await act(async () =>
    pending.resolve({
      _tag: "Success",
      value: { agentId: "gemini", version: "1.2.3", distribution: "npx", prepared: true },
    }),
  );

  expect(onPrepared).not.toHaveBeenCalled();
});

it("shows an existing registry configuration as already added", async () => {
  state.result = { agents: [gemini] };
  await render({ configured: true });
  await expect
    .element(page.getByRole("button", { name: "Already added Gemini CLI" }))
    .toBeDisabled();
});

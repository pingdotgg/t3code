import type { ReactElement } from "react";
import { EnvironmentId, ProviderDriverKind, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  search: Symbol("acp-search"),
  prepare: Symbol("acp-prepare"),
}));

const state = vi.hoisted(() => ({
  result: null as { readonly agents: ReadonlyArray<AcpRegistrySearchAgent> } | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
  search: vi.fn(() => atoms.search),
  prepare: vi.fn(),
}));

const lifecycle = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) lifecycle.cleanups.push(cleanup);
    },
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    searchAcpRegistry: state.search,
    prepareAcpRegistryAgent: atoms.prepare,
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.result,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.prepare,
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => new Error("Prepare failed."),
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
  icon: "https://example.com/icon.png",
  distribution: "npx",
  integrity: "registry",
};

function render(options?: {
  readonly configured?: boolean;
  readonly onPrepared?: (agent: AcpRegistrySearchAgent) => void;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return AcpRegistrySearchStep({
    environmentId,
    providerInstances: options?.configured
      ? {
          acpRegistry_gemini: {
            driver: ProviderDriverKind.make("acpRegistry"),
            config: { agentId: "gemini" },
          },
        }
      : {},
    onPrepared: options?.onPrepared ?? vi.fn(),
    onManualConfiguration: vi.fn(),
  }) as ReactElement<Record<string, unknown>>;
}

function findByAriaLabel(
  tree: ReactElement<Record<string, unknown>>,
  label: string,
): ReactElement<Record<string, unknown>> {
  const found = visitElements(tree, (element) => element.props["aria-label"] === label);
  expect(found).not.toBeNull();
  return found!;
}

describe("AcpRegistrySearchStep", () => {
  beforeEach(() => {
    hooks.reset();
    state.result = null;
    state.error = null;
    state.isPending = false;
    state.refresh.mockReset();
    state.search.mockClear();
    state.prepare.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { agentId: "gemini", version: "1.2.3", distribution: "npx", prepared: true },
    });
    lifecycle.cleanups = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
  });

  it("loads the full compatible catalog on open and narrows it with a search", () => {
    const initial = render();
    expect(state.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "" },
    });

    const input = findByAriaLabel(initial, "Search ACP Registry");
    expect(input.props.size).toBe("sm");
    (input.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined)?.(
      { currentTarget: { value: "  Gemini  " } },
    );
    const narrowedDraft = render();
    const form = visitElements(narrowedDraft, (element) => element.type === "form");
    (form?.props.onSubmit as ((event: { preventDefault: () => void }) => void) | undefined)?.({
      preventDefault: vi.fn(),
    });

    render();
    expect(state.search).toHaveBeenLastCalledWith({
      environmentId,
      input: { query: "Gemini" },
    });
  });

  it("renders deterministic loading, error, and empty states", () => {
    state.isPending = true;
    expect(
      visitElements(render(), (element) => element.props.children === "Searching the registry..."),
    ).not.toBeNull();

    state.isPending = false;
    state.error = "Registry unavailable.";
    expect(
      visitElements(render(), (element) => element.props.children === "Registry unavailable."),
    ).not.toBeNull();

    state.error = null;
    state.result = { agents: [] };
    expect(
      visitElements(render(), (element) => element.props.children === "No compatible agents found"),
    ).not.toBeNull();
  });

  it("keeps same-query refreshes visible and announced while retaining results", () => {
    const first = render();
    const suggestion = visitElements(first, (element) => element.props.children === "Codex");
    (suggestion?.props.onClick as (() => void) | undefined)?.();

    state.result = { agents: [gemini] };
    const resultTree = render();
    expect(state.search).toHaveBeenCalledWith({
      environmentId,
      input: { query: "Codex" },
    });
    const form = visitElements(resultTree, (element) => element.type === "form");
    (form?.props.onSubmit as ((event: { preventDefault: () => void }) => void) | undefined)?.({
      preventDefault: vi.fn(),
    });
    expect(state.refresh).toHaveBeenCalledOnce();

    state.isPending = true;
    const refreshingTree = render();
    expect(
      visitElements(
        refreshingTree,
        (element) => element.props.children === "Refreshing registry results...",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        refreshingTree,
        (element) =>
          element.props.role === "status" &&
          element.props.children === "Refreshing ACP Registry results.",
      ),
    ).not.toBeNull();
    expect(findByAriaLabel(refreshingTree, "Add Gemini CLI")).not.toBeNull();
  });

  it("prepares a result before handing it back to the wizard", async () => {
    state.prepare.mockResolvedValueOnce({
      _tag: "Success",
      value: { agentId: "gemini", version: "2.0.0", distribution: "binary", prepared: true },
    });
    state.result = { agents: [gemini] };
    const onPrepared = vi.fn();
    const tree = render({ onPrepared });

    const add = findByAriaLabel(tree, "Add Gemini CLI");
    (add.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(state.prepare).toHaveBeenCalledWith({
      environmentId,
      input: { agentId: "gemini" },
    });
    expect(onPrepared).toHaveBeenCalledWith({
      ...gemini,
      version: "2.0.0",
      distribution: "binary",
    });
  });

  it("ignores a stale prepare completion", async () => {
    let resolveFirst!: (value: { readonly _tag: "Success"; readonly value: unknown }) => void;
    let resolveSecond!: (value: { readonly _tag: "Success"; readonly value: unknown }) => void;
    state.prepare
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    state.result = { agents: [gemini] };
    const onPrepared = vi.fn();
    const tree = render({ onPrepared });
    const add = findByAriaLabel(tree, "Add Gemini CLI");

    (add.props.onClick as (() => void) | undefined)?.();
    (add.props.onClick as (() => void) | undefined)?.();
    resolveFirst({ _tag: "Success", value: {} });
    await Promise.resolve();
    expect(onPrepared).not.toHaveBeenCalled();

    resolveSecond({ _tag: "Success", value: {} });
    await Promise.resolve();
    expect(onPrepared).toHaveBeenCalledOnce();
  });

  it("ignores prepare completion after unmount", async () => {
    let resolvePrepare!: (value: { readonly _tag: "Success"; readonly value: unknown }) => void;
    state.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    state.result = { agents: [gemini] };
    const onPrepared = vi.fn();
    const tree = render({ onPrepared });

    const add = findByAriaLabel(tree, "Add Gemini CLI");
    (add.props.onClick as (() => void) | undefined)?.();
    for (const cleanup of lifecycle.cleanups) cleanup();
    resolvePrepare({ _tag: "Success", value: {} });
    await Promise.resolve();

    expect(onPrepared).not.toHaveBeenCalled();
  });

  it("renders existing registry configuration as already added", () => {
    state.result = { agents: [gemini] };
    const tree = render({ configured: true });
    const added = findByAriaLabel(tree, "Already added Gemini CLI");

    expect(added.props.disabled).toBe(true);
  });

  it("shows catalog metadata, uniquely named reference links, and a local icon fallback", () => {
    state.result = { agents: [gemini] };
    const tree = render();

    // Author emails are stripped, registry-integrity gets no marker, and the
    // version renders beside the name instead of inside the meta line.
    for (const item of ["Google +1", "v1.2.3", "npx", "Apache-2.0"]) {
      expect(visitElements(tree, (element) => element.props.children === item)).not.toBeNull();
    }
    for (const absent of ["Registry", "✓ checksum"]) {
      expect(visitElements(tree, (element) => element.props.children === absent)).toBeNull();
    }
    expect(
      visitElements(
        tree,
        (element) => element.props["aria-label"] === "Open documentation for Gemini CLI (gemini)",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        tree,
        (element) => element.props["aria-label"] === "Open source for Gemini CLI (gemini)",
      ),
    ).not.toBeNull();
    expect(visitElements(tree, (element) => element.type === "img")).toBeNull();
  });
});

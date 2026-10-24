import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const refreshProviders = vi.hoisted(() => vi.fn());
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  readComposerDraftSelection: () => null,
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => refreshProviders,
}));

import { useComposerCommandMenu } from "./use-composer-command-menu";

const NOW = 1_800_000_000_000;
const CWD = "/workspace/project";

function catalog(checkedAt: number, recovered = false): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(checkedAt).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    workspaceSnapshots: [
      {
        cwd: CWD,
        checkedAt: new Date(checkedAt).toISOString(),
        slashCommands: [],
        skills: recovered ? [{ name: "recovered", path: `${CWD}/SKILL.md`, enabled: true }] : [],
      },
    ],
  };
}

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  let resolveResponse!: (provider: ServerProvider) => void;
  const response = new Promise<ServerProvider>((resolve) => {
    resolveResponse = resolve;
  });
  let publish!: (provider: ServerProvider) => void;
  const recovered = catalog(NOW + 2 * PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS, true);
  refreshProviders.mockReset();
  refreshProviders.mockImplementationOnce(async () => {
    const provider = await response;
    publish(provider);
    return { _tag: "Success", value: { providers: [provider] } };
  });
  refreshProviders.mockImplementation(async () => {
    publish(recovered);
    return { _tag: "Success", value: { providers: [recovered] } };
  });
  function Picker({ draft }: { draft: string }) {
    const [provider, setProvider] = useState(() =>
      catalog(NOW - PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS),
    );
    useEffect(() => {
      publish = setProvider;
    }, []);
    const menu = useComposerCommandMenu({
      draftMessage: draft,
      ownerKey: null,
      environmentId: EnvironmentId.make("environment-1"),
      projectCwd: CWD,
      selectedProviderStatus: provider,
      hasThread: true,
      hasCompactableConversation: false,
      onChangeDraftMessage: () => {},
    });
    return <>{menu.items.map((item) => item.label).join(",")}</>;
  }
  try {
    await act(async () => root.render(<Picker draft="$" />));
  } catch (error) {
    act(() => root.unmount());
    throw error;
  }
  return {
    container,
    async respond(provider: ServerProvider) {
      await act(async () => resolveResponse(provider));
    },
    async type(draft: string) {
      await act(async () => root.render(<Picker draft={draft} />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it.each(["already expired", "expired during discovery"] as const)(
  "recovers a missing skill after the short cooldown when the returned catalog is %s",
  async (expiry) => {
    using now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    using picker = await mount();
    const checkedAt =
      expiry === "already expired"
        ? NOW - PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS
        : NOW - PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS + 1;
    const completedAt = expiry === "already expired" ? NOW : NOW + 1;
    now.mockReturnValue(completedAt);
    await picker.respond(catalog(checkedAt));
    now.mockReturnValue(completedAt + 9_999);
    await picker.type("$r");
    expect(picker.container.textContent).not.toContain("recovered");
    now.mockReturnValue(completedAt + 10_000);
    await picker.type("$re");
    expect(picker.container.textContent).toContain("recovered");
  },
);

it("keeps the normal refresh interval when discovery returns a current catalog", async () => {
  using now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  using picker = await mount();
  await picker.respond(catalog(NOW));
  now.mockReturnValue(NOW + 10_000);
  await picker.type("$r");
  expect(picker.container.textContent).not.toContain("recovered");
  now.mockReturnValue(NOW + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
  await picker.type("$re");
  expect(picker.container.textContent).toContain("recovered");
});

import { Atom } from "effect/reactivity";
import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { useComposerMenuItems } from "./useComposerMenuItems";

const state = vi.hoisted(() => ({
  threads: [] as ReadonlyArray<EnvironmentThreadShell>,
  paths: {
    entries: [{ kind: "file" as const, path: "src/search.ts" }],
    searchedTarget: null,
    isPending: false,
  },
}));
vi.mock("~/state/entities", () => ({
  useVisibleThreadShells: () => state.threads,
  useProjects: () => [],
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentIdentities: () => [],
  useEnvironmentMachines: () => new Map(),
}));
vi.mock("~/state/peerLinks", () => ({ offersLinkedEnvironmentsAtom: () => Atom.make(false) }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: () => undefined,
  usePullRequestList: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, isPending: false }),
}));
vi.mock("~/state/queries", () => ({
  useComposerPathSearch: () => state.paths,
  useDebouncedValue: (value: unknown) => value,
  useThreadSearch: () => {},
}));

function setup() {
  state.threads = [];
  state.paths = {
    entries: [{ kind: "file", path: "src/search.ts" }],
    searchedTarget: null,
    isPending: false,
  };
}

function Menu({ query }: { query: string }) {
  const { items } = useComposerMenuItems({
    composerTrigger: { kind: "path", query, rangeStart: 0, rangeEnd: query.length + 1 },
    environmentId: EnvironmentId.make("environment-test"),
    linkedEnvironments: new Map(),
    gitCwd: "/repo",
    activeThreadId: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    planModeUiEnabled: false,
    sideChatAvailable: false,
    sideChatDisabledReason: null,
    freshSessionAvailable: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [],
    showSkillsInSlashMenu: false,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
  });
  return <output>{JSON.stringify(items.map((item) => item.id))}</output>;
}

it("retains older thread matches arriving after files settle during the next search", async () => {
  setup();
  await using screen = await render(<Menu query="search" />);
  const fileId = "path:file:src/search.ts";
  await expect.element(screen.getByRole("status")).toHaveTextContent(JSON.stringify([fileId]));

  const olderThread = makeThreadFixture({ title: "search older history" });
  state.threads = [olderThread];
  await screen.rerender(<Menu query="search" />);
  const settledIds = [`thread:${olderThread.environmentId}:${olderThread.id}`, fileId];
  await expect.element(screen.getByRole("status")).toHaveTextContent(JSON.stringify(settledIds));

  state.paths = { ...state.paths, entries: [], isPending: true };
  await screen.rerender(<Menu query="search o" />);
  await expect.element(screen.getByRole("status")).toHaveTextContent(JSON.stringify(settledIds));

  state.paths = { ...state.paths, isPending: false };
  await screen.rerender(<Menu query="search o" />);
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(JSON.stringify([settledIds[0]]));
});

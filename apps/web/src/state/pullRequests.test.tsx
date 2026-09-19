import {
  EnvironmentId,
  ProjectId,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListResult,
  type PullRequestRef,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolvePullRequestPanelReferences } from "../components/pullRequest/pullRequestDetail.logic";

import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  pullRequestEnvironment,
  pullRequestListEntryToSummary,
  usePullRequestList,
  useSharedPullRequestSummary,
} from "./pullRequests";

type MockListAtom = Atom.Writable<AsyncResult.AsyncResult<PullRequestListResult>>;
const mockedListAtoms = vi.hoisted(() => new Map<string, MockListAtom>());

vi.mock("@t3tools/client-runtime/state/pull-requests", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@t3tools/client-runtime/state/pull-requests")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const list = (target: { environmentId: EnvironmentId; input: PullRequestListInput }) => {
    const key = JSON.stringify(target);
    const existing = mockedListAtoms.get(key);
    if (existing !== undefined) return existing;
    const created = Atom.make<AsyncResult.AsyncResult<PullRequestListResult>>(
      AsyncResult.initial(false),
    );
    mockedListAtoms.set(key, created);
    return created;
  };
  const refreshes = () => Atom.make(AsyncResult.initial<number>(false));
  return {
    ...original,
    createPullRequestEnvironmentAtoms: () => ({
      list,
      listStats: list,
      refreshes,
    }),
  };
});

const listInput: PullRequestListInput = { state: "open" };
const projectId = ProjectId.make("pull-request-cache-test");
let sequence = 0;
let renderer: ReactTestRenderer | undefined;

function entry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    provider: "github",
    host: "github.com",
    projectId,
    projectTitle: "Cache test",
    repository: "acme/widget",
    number: 7,
    title: "Improve widget",
    url: "https://github.com/acme/widget/pull/7",
    author: { login: "oliver", name: null, avatarUrl: null },
    headBranch: "improve-widget",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 4,
    deletions: 2,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  };
}

function answer(...entries: PullRequestListEntry[]): PullRequestListResult {
  return {
    viewers: { "github.com": "oliver" },
    providers: [],
    entries,
    errors: [],
    truncated: false,
    nextCursors: {},
  };
}

function target(environmentId: EnvironmentId) {
  return { environmentId, input: listInput };
}

function listAtomFor(environmentId: EnvironmentId) {
  const queryTarget = target(environmentId);
  pullRequestEnvironment.list(queryTarget);
  const atom = mockedListAtoms.get(JSON.stringify(queryTarget));
  if (atom === undefined) throw new Error("List atom was not created");
  return atom;
}

function reference(entryValue: PullRequestListEntry) {
  return {
    projectId: entryValue.projectId,
    host: entryValue.host,
    repository: entryValue.repository,
    number: entryValue.number,
  };
}

let observed: PullRequestSummary | null = null;

function ListProbe({ environmentIds }: { environmentIds: ReadonlyArray<EnvironmentId> }) {
  usePullRequestList(environmentIds.map(target));
  return null;
}

function SidebarProbe({
  environmentId,
  reference: ref,
  current = null,
  observedAt,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  current?: PullRequestSummary | null;
  observedAt?: number | null;
}) {
  const summary = useSharedPullRequestSummary(environmentId, ref, current, observedAt);
  useLayoutEffect(() => {
    observed = summary;
  }, [summary]);
  return null;
}

async function mount(element: React.ReactElement) {
  await act(() => {
    renderer?.unmount();
    renderer = create(<AppAtomRegistryProvider>{element}</AppAtomRegistryProvider>);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observed = null;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("pull request summary cache", () => {
  it("keeps a list result available to the sidebar after the list unmounts", async () => {
    const environmentId = EnvironmentId.make(`cache-${sequence++}`);
    const row = entry({ mergeability: "conflicting" });
    const listAtom = listAtomFor(environmentId);
    appAtomRegistry.set(listAtom, AsyncResult.success(answer(row), { timestamp: 100 }));

    await mount(<ListProbe environmentIds={[environmentId]} />);
    await act(() => renderer?.unmount());
    renderer = undefined;
    await mount(
      <SidebarProbe environmentId={environmentId} reference={reference(row)} observedAt={100} />,
    );

    expect(observed?.title).toBe(row.title);
    expect(observed?.mergeability).toBe("conflicting");
  });

  it("reuses host-scoped list summaries when a legacy server needs hostless requests", async () => {
    const environmentId = EnvironmentId.make(`cache-${sequence++}`);
    const publicRow = entry({ title: "Public PR" });
    const enterpriseRow = entry({
      host: "github.example.test",
      url: "https://github.example.test/acme/widget/pull/7",
      title: "Enterprise PR",
      mergeability: "conflicting",
    });
    appAtomRegistry.set(
      listAtomFor(environmentId),
      AsyncResult.success(answer(publicRow, enterpriseRow), { timestamp: 200 }),
    );
    await mount(<ListProbe environmentIds={[environmentId]} />);

    const legacy = resolvePullRequestPanelReferences(reference(enterpriseRow), null, false);
    expect(legacy.reference).toEqual({
      projectId,
      repository: enterpriseRow.repository,
      number: enterpriseRow.number,
    });
    await mount(<SidebarProbe environmentId={environmentId} reference={legacy.cacheReference} />);
    expect(observed?.title).toBe("Enterprise PR");
    expect(observed?.mergeability).toBe("conflicting");

    const publicLegacy = resolvePullRequestPanelReferences(reference(publicRow), null, false);
    await mount(
      <SidebarProbe environmentId={environmentId} reference={publicLegacy.cacheReference} />,
    );
    expect(observed?.title).toBe("Public PR");
    expect(observed?.mergeability).toBe("mergeable");
  });

  it("keeps environments and hosts isolated, then accepts a newer same-dated update", async () => {
    const firstEnvironment = EnvironmentId.make(`cache-${sequence++}`);
    const secondEnvironment = EnvironmentId.make(`cache-${sequence++}`);
    const first = entry({ mergeability: "conflicting" });
    const second = entry({ host: "github.example.test", title: "Enterprise widget" });
    const firstAtom = listAtomFor(firstEnvironment);
    const secondAtom = listAtomFor(secondEnvironment);

    appAtomRegistry.set(firstAtom, AsyncResult.success(answer(first), { timestamp: 200 }));
    appAtomRegistry.set(secondAtom, AsyncResult.success(answer(second), { timestamp: 200 }));
    await mount(<ListProbe environmentIds={[firstEnvironment, secondEnvironment]} />);
    await act(() => renderer?.unmount());
    renderer = undefined;

    await mount(
      <SidebarProbe
        environmentId={firstEnvironment}
        reference={reference(first)}
        observedAt={200}
      />,
    );
    expect(observed?.mergeability).toBe("conflicting");
    await act(() => renderer?.unmount());
    renderer = undefined;
    await mount(
      <SidebarProbe
        environmentId={secondEnvironment}
        reference={reference(second)}
        observedAt={200}
      />,
    );
    expect(observed?.title).toBe("Enterprise widget");
    await act(() => renderer?.unmount());
    renderer = undefined;
    await mount(
      <SidebarProbe
        environmentId={firstEnvironment}
        reference={reference(second)}
        observedAt={200}
      />,
    );
    expect(observed).toBeNull();
    await act(() => renderer?.unmount());
    renderer = undefined;
    await mount(
      <SidebarProbe
        environmentId={secondEnvironment}
        reference={reference(first)}
        observedAt={200}
      />,
    );
    expect(observed).toBeNull();

    const updated = entry({ mergeability: "mergeable", updatedAt: first.updatedAt });
    await mount(
      <SidebarProbe
        environmentId={firstEnvironment}
        reference={reference(updated)}
        current={pullRequestListEntryToSummary(updated)}
        observedAt={100}
      />,
    );
    expect(observed?.mergeability).toBe("conflicting");
    await act(() => renderer?.unmount());
    renderer = undefined;
    appAtomRegistry.set(firstAtom, AsyncResult.success(answer(updated), { timestamp: 300 }));
    await mount(<ListProbe environmentIds={[firstEnvironment]} />);
    await act(() => renderer?.unmount());
    renderer = undefined;
    await mount(
      <SidebarProbe
        environmentId={firstEnvironment}
        reference={reference(updated)}
        current={pullRequestListEntryToSummary(updated)}
        observedAt={300}
      />,
    );
    expect(observed?.mergeability).toBe("mergeable");

    await mount(
      <SidebarProbe
        environmentId={firstEnvironment}
        reference={reference(first)}
        current={pullRequestListEntryToSummary(first)}
        observedAt={400}
      />,
    );
    expect(observed?.mergeability).toBe("conflicting");
    await mount(
      <SidebarProbe
        environmentId={firstEnvironment}
        reference={reference(first)}
        current={pullRequestListEntryToSummary(updated)}
        observedAt={500}
      />,
    );
    expect(observed?.mergeability).toBe("mergeable");
    await mount(<ListProbe environmentIds={[firstEnvironment]} />);
    await mount(<SidebarProbe environmentId={firstEnvironment} reference={reference(first)} />);
    expect(observed?.mergeability).toBe("mergeable");
  });
});

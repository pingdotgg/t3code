import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  CommandId,
  EnvironmentId,
  ProjectFactId,
  ProjectId,
  ThreadId,
  type ProjectFact,
  type ProjectFileHistoryResult,
  type ProjectKnowledgeSearchResult,
  type ProjectCodeCoverage,
  type ProjectCodeQueryInput,
  type ProjectCodeQueryResult,
  type ProjectCodeSymbol,
  type ProjectKnowledgeSearchInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  queries: [] as Array<{ environmentId: string; input: unknown }>,
  searches: [] as Array<{ environmentId: string; input: ProjectKnowledgeSearchInput }>,
  searchAtoms: new Map<string, unknown>(),
  capabilities: { projectCode: true, projectKnowledge: true } as Record<string, boolean>,
  canReadThreads: true,
}));
vi.mock(
  import("../../state/server"),
  () =>
    ({
      serverEnvironment: {
        configValueAtom: () =>
          Atom.make({ environment: { capabilities: { ...state.capabilities } } }),
      },
    }) as never,
);
vi.mock(
  import("../../state/projectCode"),
  () =>
    ({
      projectCode: {
        query: Object.assign(
          (target: { environmentId: string; input: ProjectCodeQueryInput }) => {
            state.queries.push(target);
            return (
              state.results.get(target.input.query.operation) ??
              Atom.make(AsyncResult.initial(true))
            );
          },
          { permissionAtom: () => Atom.make(true) },
        ),
        freshness: Object.assign(
          (target: { environmentId: string; input: ProjectCodeQueryInput }) => {
            state.queries.push(target);
            return state.results.get("freshness") ?? Atom.make(AsyncResult.initial(true));
          },
          { permissionAtom: () => Atom.make(true) },
        ),
        fileHistory: Object.assign(
          (target: { environmentId: string; input: unknown }) => {
            state.queries.push(target);
            return state.results.get("history") ?? Atom.make(AsyncResult.initial(true));
          },
          { permissionAtom: () => Atom.make(state.canReadThreads) },
        ),
      },
    }) as never,
);
vi.mock(
  import("../../state/projectKnowledge"),
  () =>
    ({
      projectKnowledge: {
        search: (target: { environmentId: string; input: ProjectKnowledgeSearchInput }) => {
          const key = JSON.stringify(target);
          if (!state.searchAtoms.has(key)) {
            state.searches.push(target);
            state.searchAtoms.set(
              key,
              state.results.get(`decisions:${target.input.factCursor?.offset ?? 0}`) ??
                state.results.get("decisions") ??
                Atom.make(AsyncResult.initial(true)),
            );
          }
          return state.searchAtoms.get(key);
        },
      },
    }) as never,
);
vi.mock(
  import("../../state/entities"),
  () =>
    ({
      useQuietThreadShell: () => ({ id: "thread", projectId: "project" }),
    }) as never,
);

import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { FileCodeRelationships } from "./FileCodeRelationships";

const threadRef = {
  environmentId: EnvironmentId.make("code-browser"),
  threadId: ThreadId.make("thread"),
};
const coverage = (state: ProjectCodeCoverage["state"]): ProjectCodeCoverage => ({
  state,
  catalogRevision: "test",
  relationSemantics: "static-candidates",
  columnEncoding: "utf16-code-units",
  languages: ["typescript"],
  filesListed: 12,
  filesIndexed: 10,
  filesSkipped: 2,
  filesUnsupported: 0,
  filesFailed: 0,
  pendingReferences: 0,
  resultLimitReached: false,
  limitations: ["Relations are static candidates."],
});
const symbol = (id: string, name: string, path: string, startLine: number): ProjectCodeSymbol => ({
  id,
  name,
  qualifiedName: name,
  kind: "function",
  language: "typescript",
  path,
  startLine,
  endLine: startLine + 2,
  startColumn: 0,
  endColumn: 1,
  signature: null,
  isExported: true,
});
const result = (
  operation: ProjectCodeQueryResult["operation"],
  overrides: Partial<ProjectCodeQueryResult>,
): ProjectCodeQueryResult => ({
  operation,
  checkoutPath: "/repo",
  matches: [],
  nodes: [],
  edges: [],
  files: [],
  unresolvedReferences: [],
  selection: { state: "not-required", candidates: [] },
  sourceDigests: [],
  stats: null,
  coverage: coverage("complete"),
  ...overrides,
});
const greet = symbol("greet", "greet", "src/defs.ts", 4);
const caller = symbol("caller", "caller", "src/use.ts", 10);
const spec = symbol("spec", "greets", "src/defs.test.ts", 3);
const edge = (source: string, line: number | null) => ({
  source,
  target: greet.id,
  kind: "calls",
  confidence: null,
  resolvedBy: "import",
  provenance: null,
  evidenceGrade: "static-candidate" as const,
  line,
  column: null,
  referenceName: null,
  candidateTargets: [],
});

function setup(outline: ProjectCodeQueryResult) {
  state.queries.length = 0;
  state.searches.length = 0;
  state.searchAtoms.clear();
  state.capabilities = {
    projectCode: true,
    projectKnowledge: true,
    projectCodeFreshness: true,
    projectCodeTests: true,
    projectCodeFileHistory: true,
    projectCodePath: true,
    projectCodeAffected: true,
  };
  state.canReadThreads = true;
  state.results.clear();
  state.results.set("symbols", Atom.make(AsyncResult.success(outline)));
  state.results.set(
    "callers",
    Atom.make(
      AsyncResult.success(
        result("callers", {
          nodes: [greet, caller],
          edges: [edge(caller.id, 12)],
          selection: { state: "matched", candidates: [greet] },
        }),
      ),
    ),
  );
  state.results.set(
    "impact",
    Atom.make(
      AsyncResult.success(
        result("impact", {
          nodes: [greet, caller, spec],
          edges: [edge(caller.id, 12), edge(spec.id, 5)],
          selection: { state: "matched", candidates: [greet] },
        }),
      ),
    ),
  );
  useRightPanelStore.setState({ byThreadKey: {} });
  return AtomRegistry.make();
}

const activeSurface = () =>
  selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef);

it("queries only on demand, labels stale static evidence, and opens results at their line", async () => {
  const registry = setup(result("symbols", { nodes: [greet], coverage: coverage("stale") }));
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <FileCodeRelationships
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        relativePath="src/defs.ts"
      />
    </RegistryContext.Provider>,
  );
  const header = screen.getByRole("button", { name: "Code relationships" });
  await expect.element(header).toBeVisible();
  expect(state.queries).toEqual([]);

  await header.click();
  await expect.element(screen.getByText(/Stale · some returned files changed/)).toBeVisible();
  expect(
    state.queries.find(
      ({ input }) => (input as ProjectCodeQueryInput).query?.operation === "symbols",
    ),
  ).toEqual({
    environmentId: threadRef.environmentId,
    input: {
      projectId: ProjectId.make("project"),
      threadId: threadRef.threadId,
      query: { operation: "symbols", filePath: "src/defs.ts", limit: 50 },
    },
  });

  await screen.getByRole("button", { name: /^greet/ }).click();
  expect(activeSurface()).toMatchObject({ relativePath: "src/defs.ts", revealLine: 4 });

  // A caller opens at the call site, not the caller's declaration.
  await screen.getByRole("button", { name: /src\/use\.ts:12/ }).click();
  expect(activeSurface()).toMatchObject({ relativePath: "src/use.ts", revealLine: 12 });

  await screen.getByRole("button", { name: "Impact" }).click();
  const rows = screen.getByRole("button", { name: /symbol · static candidate/ });
  // Likely affected tests sort first.
  await expect.element(rows.nth(1)).toBeVisible();
  expect(rows.elements().map((row) => row.textContent)).toEqual([
    "testsrc/defs.test.ts1 symbol · static candidate",
    "filesrc/use.ts1 symbol · static candidate",
  ]);
  await rows.first().click();
  expect(activeSurface()).toMatchObject({ relativePath: "src/defs.test.ts", revealLine: 3 });
});

it("says when a file has no indexed declarations instead of implying it has none", async () => {
  const registry = setup(result("symbols", { coverage: coverage("partial") }));
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <FileCodeRelationships
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        relativePath="README.weird"
      />
    </RegistryContext.Provider>,
  );
  await screen.getByRole("button", { name: "Code relationships" }).click();
  await expect.element(screen.getByText(/partial coverage, 10 of 12 files indexed/)).toBeVisible();
  await expect.element(screen.getByText(/language may be unsupported/)).toBeVisible();
});

const renderSection = (registry: AtomRegistry.AtomRegistry, relativePath = "src/defs.ts") =>
  render(
    <RegistryContext.Provider value={registry}>
      <FileCodeRelationships
        environmentId={threadRef.environmentId}
        threadRef={threadRef}
        relativePath={relativePath}
      />
    </RegistryContext.Provider>,
  );

const fact = (id: string, entities: ReadonlyArray<string>, content: string): ProjectFact => ({
  id: ProjectFactId.make(id),
  projectId: ProjectId.make("project"),
  origin: { kind: "user" },
  kind: "decision",
  revision: 1,
  trust: 0.8,
  retrievalCount: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  content,
  entities: [...entities],
  tags: [],
  sources: [],
  status: "saved",
  forgottenAt: null,
});

it("matches decisions by this file's path and symbol names, warning that names are not identities", async () => {
  const registry = setup(result("symbols", { nodes: [greet] }));
  const search: ProjectKnowledgeSearchResult = {
    messages: { matches: [] },
    facts: {
      state: "available",
      coverage: "complete",
      nextCursor: null,
      matches: [
        {
          fact: fact("by-path", ["src/defs.ts"], "Defs stay dependency free."),
          score: {} as never,
        },
        { fact: fact("by-name", ["greet"], "Greetings are localized."), score: {} as never },
      ],
    },
  };
  state.results.set("decisions", Atom.make(AsyncResult.success(search)));
  await using screen = await renderSection(registry);
  await screen.getByRole("button", { name: "Code relationships" }).click();
  await screen.getByRole("button", { name: "Decisions", exact: true }).click();

  await expect.element(screen.getByText("Defs stay dependency free.")).toBeVisible();
  await expect.element(screen.getByText("matched by path src/defs.ts")).toBeVisible();
  await expect.element(screen.getByText("matched by name greet")).toBeVisible();
  await expect.element(screen.getByText(/Name, not identity/)).toBeVisible();
  // The symbol names come from the outline, so the search waits for it and names both.
  expect(state.searches).toHaveLength(1);
  expect(state.searches[0]!.input).toMatchObject({
    projectId: "project",
    entities: ["src/defs.ts", "defs.ts", "greet"],
    entityMatch: "any",
  });
});

it("lists prior work as present at checkpoint and opens the thread", async () => {
  const registry = setup(result("symbols", { nodes: [greet] }));
  const history: ProjectFileHistoryResult = {
    path: "src/defs.ts",
    relation: "present-at-checkpoint",
    entries: [
      {
        threadId: ThreadId.make("history-thread"),
        title: "Refactor greetings",
        archived: true,
        checkpoints: 2,
        lastCheckpointAt: "2026-10-01T00:00:00.000Z",
        lastKind: "modified",
        additions: 4,
        deletions: 1,
      },
    ],
    limitReached: false,
    index: { state: "catching-up", pendingCheckpoints: 30 },
  };
  state.results.set("history", Atom.make(AsyncResult.success(history)));
  await using screen = await renderSection(registry);
  await screen.getByRole("button", { name: "Code relationships" }).click();
  await screen.getByRole("button", { name: "Prior work", exact: true }).click();

  await expect
    .element(screen.getByText(/the file changed in that thread's workspace/))
    .toBeVisible();
  await expect.element(screen.getByText("30 older checkpoints are not indexed yet.")).toBeVisible();
  const row = screen.getByRole("button", { name: /Refactor greetings/ });
  await expect.element(row).toBeVisible();
  expect(row.element().textContent).toContain("present at 2 checkpoints");
  expect(row.element().textContent).toContain("archived");
  expect(screen.container.textContent).not.toMatch(/authored/i);
  await row.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/code-browser/history-thread"),
  );
});

it("offers only the views this connection and server can answer", async () => {
  const registry = setup(result("symbols", { nodes: [greet] }));
  state.capabilities = { projectCode: true };
  state.canReadThreads = false;
  await using screen = await renderSection(registry);
  await screen.getByRole("button", { name: "Code relationships" }).click();
  await expect.element(screen.getByRole("button", { name: /^greet/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "Prior work", exact: true }).elements()).toHaveLength(
    0,
  );
  expect(screen.getByRole("button", { name: "Decisions", exact: true }).elements()).toHaveLength(0);
});

it("shows a static index badge and tests reaching the selected symbol", async () => {
  const registry = setup(result("symbols", { nodes: [greet] }));
  state.results.set(
    "freshness",
    Atom.make(
      AsyncResult.success(
        result("freshness", {
          index: {
            state: "stale",
            indexedCommit: "abcdef0123456789",
            headCommit: "1234567890abcdef",
            generation: 4,
            indexedAt: 0,
            changedFiles: 3,
            changedPaths: [],
          },
        }),
      ),
    ),
  );
  state.results.set(
    "tests",
    Atom.make(
      AsyncResult.success(
        result("tests", {
          nodes: [greet, caller, spec],
          edges: [edge(caller.id, 12), { ...edge(spec.id, 5), target: caller.id }],
          selection: { state: "matched", candidates: [greet] },
          symbolGroups: [{ symbol: greet.id, callers: [], tests: [spec.id] }],
        }),
      ),
    ),
  );
  await using screen = await renderSection(registry);
  const header = screen.getByRole("button", { name: /Code relationships/ });
  await header.click();
  await expect.element(screen.getByText("Stale @abcdef0")).toBeVisible();
  await screen.getByRole("button", { name: /^greet/ }).click();
  await screen.getByRole("button", { name: "Tests", exact: true }).click();
  const row = screen.getByRole("button", { name: /src\/defs\.test\.ts:3/ });
  await expect.element(row).toBeVisible();
  expect(row.element().textContent).toContain("2 hops · static");
  await row.click();
  expect(activeSurface()).toMatchObject({ relativePath: "src/defs.test.ts", revealLine: 3 });
});

it("does not request unsupported freshness, tests or prior work and explains the server update", async () => {
  const registry = setup(result("symbols", { nodes: [greet] }));
  state.capabilities = { projectCode: true, projectKnowledge: true };
  await using screen = await renderSection(registry);
  await screen.getByRole("button", { name: "Code relationships" }).click();
  await screen.getByRole("button", { name: /^greet/ }).click();
  await screen.getByRole("button", { name: "Tests", exact: true }).click();
  await expect.element(screen.getByText("Update the server to use tests.")).toBeVisible();
  await screen.getByRole("button", { name: "Prior work", exact: true }).click();
  await expect.element(screen.getByText("Update the server to use prior work.")).toBeVisible();
  expect(
    state.queries.every(({ input }) =>
      ["symbols", "callers"].includes((input as ProjectCodeQueryInput).query?.operation),
    ),
  ).toBe(true);
});

it("requests a bounded decisions page and appends more facts without reinforcing retrieval", async () => {
  const registry = setup(result("symbols", { nodes: [greet] }));
  const page = (
    matches: ProjectFact[],
    nextCursor: { requestId: CommandId; offset: number } | null,
  ): ProjectKnowledgeSearchResult => ({
    messages: { matches: [] },
    facts: {
      state: "available",
      coverage: "complete",
      nextCursor,
      matches: matches.map((fact) => ({ fact, score: {} as never })),
    },
  });
  const first = fact("first", ["src/defs.ts"], "First decision.");
  const second = fact("second", ["greet"], "Second decision.");
  const cursor = { requestId: CommandId.make("root-search"), offset: 10 };
  state.results.set("decisions:0", Atom.make(AsyncResult.success(page([first, second], cursor))));
  state.results.set(
    "decisions:10",
    Atom.make(
      AsyncResult.success(page([second, fact("third", ["defs.ts"], "Third decision.")], null)),
    ),
  );
  await using screen = await renderSection(registry);
  await screen.getByRole("button", { name: "Code relationships" }).click();
  await screen.getByRole("button", { name: "Decisions", exact: true }).click();
  expect(state.searches[0]!.input).toMatchObject({
    limit: 10,
    messageLimit: 1,
    recordRetrieval: false,
  });
  await expect.element(screen.getByText("First decision.")).toBeVisible();
  await expect.element(screen.getByText("Second decision.")).toBeVisible();
  await screen.getByRole("button", { name: "Show more", exact: true }).click();
  await expect.element(screen.getByText("Third decision.")).toBeVisible();
  await expect.element(screen.getByText("First decision.")).toBeVisible();
  expect(
    screen.getByRole("list", { name: "Decisions for this file" }).getByRole("listitem").elements(),
  ).toHaveLength(3);
  expect(state.searches[1]!.input).toMatchObject({
    factCursor: cursor,
    limit: 10,
    messageLimit: 1,
    recordRetrieval: false,
  });
  expect(state.searches[1]!.input.requestId).not.toBe(state.searches[0]!.input.requestId);
  expect(screen.getByRole("button", { name: "Show more", exact: true }).query()).toBeNull();
});

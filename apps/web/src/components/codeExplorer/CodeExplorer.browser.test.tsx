import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ProjectCodeCoverage,
  type ProjectCodeEdge,
  type ProjectCodeIndexInfo,
  type ProjectCodeQuery,
  type ProjectCodeQueryInput,
  type ProjectCodeQueryResult,
  type ProjectCodeSymbol,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  respond: (_query: unknown): unknown => undefined,
  freshness: null as unknown,
  atoms: new Map<string, unknown>(),
  queries: [] as unknown[],
  capabilities: {} as Record<string, boolean>,
  freshnessRequests: 0,
}));
vi.mock(
  import("../../state/server"),
  () =>
    ({
      serverEnvironment: {
        configValueAtom: () => Atom.make({ environment: { capabilities: state.capabilities } }),
      },
    }) as never,
);
vi.mock(
  import("../../state/projectCode"),
  () =>
    ({
      projectCode: {
        query: Object.assign(
          (target: { input: ProjectCodeQueryInput }) => {
            state.queries.push(target.input.query);
            const key = JSON.stringify(target.input.query);
            let atom = state.atoms.get(key);
            if (atom === undefined) {
              const value = state.respond(target.input.query);
              atom = Atom.make(
                value === undefined ? AsyncResult.initial(true) : AsyncResult.success(value),
              );
              state.atoms.set(key, atom);
            }
            return atom;
          },
          { permissionAtom: () => Atom.make(true) },
        ),
        freshness: Object.assign(
          () => {
            state.freshnessRequests += 1;
            return Atom.make(
              state.freshness === null
                ? AsyncResult.initial(true)
                : AsyncResult.success(state.freshness),
            );
          },
          { permissionAtom: () => Atom.make(true) },
        ),
      },
    }) as never,
);

import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { CodeExplorerDialogHost } from "./CodeExplorerDialogHost";
import { codeExplorerRequestAtom } from "./openCodeExplorer";

const environmentId = EnvironmentId.make("explorer-browser");
const projectId = ProjectId.make("project");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };

const coverage = (
  coverageState: ProjectCodeCoverage["state"],
  resultLimitReached = false,
): ProjectCodeCoverage => ({
  state: coverageState,
  catalogRevision: "test",
  relationSemantics: "static-candidates",
  columnEncoding: "utf16-code-units",
  languages: ["typescript"],
  filesListed: 10,
  filesIndexed: 10,
  filesSkipped: 0,
  filesUnsupported: 0,
  filesFailed: 0,
  pendingReferences: 0,
  resultLimitReached,
  limitations: ["Relations are static candidates."],
});
const index = (indexState: ProjectCodeIndexInfo["state"]): ProjectCodeIndexInfo => ({
  state: indexState,
  indexedCommit: "abcdef1234",
  headCommit: "abcdef1234",
  generation: 3,
  indexedAt: 1,
  changedFiles: indexState === "stale" ? 2 : 0,
  changedPaths: [],
});
const symbol = (name: string, path: string, startLine: number): ProjectCodeSymbol => ({
  id: name,
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
const edge = (
  source: string,
  target: string,
  evidenceGrade: ProjectCodeEdge["evidenceGrade"],
  line: number | null = null,
): ProjectCodeEdge => ({
  source,
  target,
  kind: "calls",
  confidence: null,
  resolvedBy: null,
  provenance: null,
  evidenceGrade,
  line,
  column: null,
  referenceName: null,
  candidateTargets: [],
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

const greet = symbol("greet", "src/defs.ts", 4);
const caller = symbol("caller", "src/use.ts", 10);
const main = symbol("main", "src/main.ts", 1);
const format = symbol("format", "src/fmt.ts", 2);
const helpers = Array.from({ length: 40 }, (_, i) => symbol(`helper${i}`, `src/h${i}.ts`, 1));

const relation = (
  operation: "callers" | "callees",
  focus: ProjectCodeSymbol,
  nodes: ReadonlyArray<ProjectCodeSymbol>,
  edges: ReadonlyArray<ProjectCodeEdge>,
  coverageState: ProjectCodeCoverage["state"] = "complete",
) =>
  result(operation, {
    nodes: [focus, ...nodes],
    edges: [...edges],
    selection: { state: "matched", candidates: [focus] },
    coverage: coverage(coverageState),
  });

function respond(
  query: ProjectCodeQuery,
  coverageState: ProjectCodeCoverage["state"],
): ProjectCodeQueryResult | undefined {
  if (query.operation === "search") {
    return result("search", { matches: [{ symbol: main, score: 1, highlights: [] }] });
  }
  if (query.operation === "path") {
    const found = query.from.name === "main";
    return result("path", {
      nodes: found ? [main, caller, greet] : [],
      edges: found
        ? [
            edge("main", "caller", "static-candidate", 2),
            edge("caller", "greet", "compiler-indexed", 12),
          ]
        : [],
      selection: { state: "matched", candidates: [] },
      pathSearch: {
        found,
        maxDepth: 6,
        visitedSymbols: found ? 3 : 42,
        walkTruncated: false,
        unresolvedEndpoint: null,
      },
    });
  }
  if (query.operation !== "callers" && query.operation !== "callees") return undefined;
  const far = query.depth === 2;
  const name = query.symbol.name;
  if (name === "greet" && query.operation === "callers") {
    return relation(
      "callers",
      greet,
      far ? [caller, main] : [caller],
      [
        edge("caller", "greet", "static-candidate", 12),
        ...(far ? [edge("main", "caller", "heuristic-candidate", 3)] : []),
      ],
      coverageState,
    );
  }
  if (name === "greet") {
    return relation(
      "callees",
      greet,
      far ? [format, ...helpers] : [format],
      [
        edge("greet", "format", "compiler-indexed", 5),
        ...(far ? helpers.map((helper) => edge("format", helper.id, "static-candidate")) : []),
      ],
      coverageState,
    );
  }
  if (name === "caller" && query.operation === "callers") {
    return relation("callers", caller, [main], [edge("main", "caller", "static-candidate", 3)]);
  }
  if (name === "caller") {
    return relation("callees", caller, [greet], [edge("caller", "greet", "static-candidate", 12)]);
  }
  return undefined;
}

function setup(options?: {
  readonly coverage?: ProjectCodeCoverage["state"];
  readonly index?: ProjectCodeIndexInfo["state"];
  readonly empty?: boolean;
}) {
  state.capabilities = { projectCode: true, projectCodePath: true, projectCodeFreshness: true };
  state.freshnessRequests = 0;
  state.atoms.clear();
  state.queries.length = 0;
  state.respond = (query) => {
    const typed = query as ProjectCodeQuery;
    if (!options?.empty) return respond(typed, options?.coverage ?? "complete");
    // An unavailable index matches the symbol but has nothing around it.
    return typed.operation === "callers" || typed.operation === "callees"
      ? relation(typed.operation, greet, [], [], options.coverage)
      : undefined;
  };
  state.freshness = result("freshness", { index: index(options?.index ?? "ready") });
  useRightPanelStore.setState({ byThreadKey: {} });
  const registry = AtomRegistry.make();
  registry.set(codeExplorerRequestAtom, {
    environmentId,
    projectId,
    threadRef,
    serverThreadId: threadRef.threadId,
    symbol: greet,
    key: 1,
  });
  return registry;
}

const renderHost = (registry: AtomRegistry.AtomRegistry) =>
  render(
    <RegistryContext.Provider value={registry}>
      <CodeExplorerDialogHost environmentId={environmentId} projectId={projectId} />
    </RegistryContext.Provider>,
  );

type Screen = Awaited<ReturnType<typeof renderHost>>;
const graph = (screen: Screen, name: string) =>
  screen.getByRole("group", { name: `Call graph around ${name}` });
const left = (element: Element) => element.getBoundingClientRect().left;

it("centers the symbol with callers left and callees right, and lists the same symbols", async () => {
  const registry = setup();
  await using screen = await renderHost(registry);
  const callGraph = graph(screen, "greet");
  await expect.element(callGraph).toBeVisible();

  const focusNode = callGraph.getByRole("button", { name: /Open greet at src\/defs\.ts:4/ });
  const callerNode = callGraph.getByRole("button", { name: /Re-center on caller, caller 1 hop/ });
  const calleeNode = callGraph.getByRole("button", { name: /Re-center on format, callee 1 hop/ });
  expect(left(callerNode.element())).toBeLessThan(left(focusNode.element()));
  expect(left(focusNode.element())).toBeLessThan(left(calleeNode.element()));

  // Each connector carries its evidence grade.
  const grades = [...callGraph.element().querySelectorAll("path[data-grade]")].map((path) =>
    path.getAttribute("data-grade"),
  );
  expect(grades.toSorted()).toEqual(["compiler-indexed", "static-candidate"]);

  // The text list is the same neighbourhood, with grades and call-site lines spelled out.
  const callers = screen.getByRole("region", { name: "Callers" });
  await expect
    .element(
      callers.getByRole("button", { name: /caller.*src\/use\.ts:12.*1 hop · static candidate/ }),
    )
    .toBeVisible();
  const callees = screen.getByRole("region", { name: "Callees" });
  await expect
    .element(callees.getByRole("button", { name: /format.*src\/fmt\.ts:2.*compiler indexed/ }))
    .toBeVisible();
  await expect.element(screen.getByText("Ready")).toBeVisible();
});

it("expands to two hops and stops drawing at the cap, saying what it left out", async () => {
  const registry = setup();
  await using screen = await renderHost(registry);
  await expect.element(graph(screen, "greet")).toBeVisible();
  expect(screen.getByText(/More were found than the explorer draws/).query()).toBeNull();

  await screen.getByRole("button", { name: "2 hops" }).click();
  await expect
    .element(
      graph(screen, "greet").getByRole("button", { name: /Re-center on main, caller 2 hops/ }),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText(
        "Showing 32 symbols. More were found than the explorer draws (60 at most, 30 per side).",
      ),
    )
    .toBeVisible();
  const calleeRows = screen.getByRole("region", { name: "Callees" }).getByRole("listitem");
  expect(calleeRows.elements()).toHaveLength(30);
  expect(state.queries).toContainEqual(
    expect.objectContaining({ operation: "callees", depth: 2, limit: 30 }),
  );
});

it("re-centers on a clicked node, goes back, and opens a symbol at its line", async () => {
  const registry = setup();
  await using screen = await renderHost(registry);
  await graph(screen, "greet")
    .getByRole("button", { name: /Re-center on caller/ })
    .click();
  await expect.element(graph(screen, "caller")).toBeVisible();
  await expect
    .element(
      graph(screen, "caller").getByRole("button", { name: /Re-center on main, caller 1 hop/ }),
    )
    .toBeVisible();

  await screen.getByRole("button", { name: "Back" }).click();
  await expect.element(graph(screen, "greet")).toBeVisible();

  // A caller opens at its call site and the explorer gets out of the way.
  await screen.getByRole("button", { name: "Open caller at src/use.ts:12" }).click();
  await expect.element(graph(screen, "greet")).not.toBeInTheDocument();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({ relativePath: "src/use.ts", revealLine: 12 });
});

it("answers a path query and states the bound of a miss", async () => {
  const registry = setup();
  await using screen = await renderHost(registry);
  await expect.element(graph(screen, "greet")).toBeVisible();

  await screen.getByRole("button", { name: "…reaches greet" }).click();
  await screen.getByRole("searchbox", { name: "Path target symbol" }).fill("main");
  await screen.getByRole("button", { name: "Find" }).click();
  await screen.getByRole("list", { name: "Path target candidates" }).getByRole("button").click();
  const route = screen.getByRole("list", { name: "Call path from main to greet" });
  await expect.element(route).toBeVisible();
  expect(
    route
      .getByRole("button")
      .elements()
      .map((row) => row.textContent),
  ).toEqual([
    "mainsrc/main.ts:1start",
    "callersrc/use.ts:10hop 1 · calls · static candidate",
    "greetsrc/defs.ts:4hop 2 · calls · compiler indexed",
  ]);

  await screen.getByRole("button", { name: "greet reaches…" }).click();
  await screen.getByRole("button", { name: "Find" }).click();
  await screen.getByRole("list", { name: "Path target candidates" }).getByRole("button").click();
  await expect
    .element(
      screen.getByText(
        /No call path from greet to main within 6 hops \(42 symbols walked\)\. That does not prove there is none\./,
      ),
    )
    .toBeVisible();
});

it("warns when the index is stale", async () => {
  const registry = setup({ coverage: "stale", index: "stale" });
  await using screen = await renderHost(registry);
  await expect.element(graph(screen, "greet")).toBeVisible();
  await expect
    .element(screen.getByText(/The index is stale for some of these files/))
    .toBeVisible();
  await expect.element(screen.getByText("Stale")).toBeVisible();
});

it("says the index is not ready instead of drawing an empty graph", async () => {
  const registry = setup({ empty: true, coverage: "unavailable", index: "unindexed" });
  await using screen = await renderHost(registry);
  await expect
    .element(
      screen.getByText(
        "The code index is not ready for this checkout, so no calls can be shown yet.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByText(/No static callers or callees found/)).toBeVisible();
  expect(graph(screen, "greet").query()).toBeNull();
  await expect.element(screen.getByText("Not indexed")).toBeVisible();
});

it("keeps the legacy explorer usable without sending unsupported path or freshness queries", async () => {
  const registry = setup();
  state.capabilities = { projectCode: true };
  await using screen = await renderHost(registry);
  await expect.element(graph(screen, "greet")).toBeVisible();
  await expect.element(screen.getByText("Update the server to use call paths.")).toBeVisible();
  expect(screen.getByRole("searchbox", { name: "Path target symbol" }).query()).toBeNull();
  expect(state.queries).not.toContainEqual(expect.objectContaining({ operation: "path" }));
  expect(state.queries).not.toContainEqual(expect.objectContaining({ operation: "search" }));
  expect(state.freshnessRequests).toBe(0);
});

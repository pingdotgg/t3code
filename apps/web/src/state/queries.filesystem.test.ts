import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  phase: "connected" as "connected" | "offline",
  sessionAtom: {},
  searchAtom: {},
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(value: A) => [value, vi.fn()],
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./projects", () => ({
  projectEnvironment: { searchEntries: () => state.searchAtom },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./threads", () => ({ useEnvironmentThread: vi.fn() }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === state.sessionAtom
        ? state.session
        : atom === state.searchAtom
          ? { entries: [{ path: "src/index.ts", kind: "file" }] }
          : null,
    error: atom === state.sessionAtom ? state.sessionError : null,
    isPending: atom === state.sessionAtom && state.session === null && state.sessionError === null,
    refresh: vi.fn(),
  }),
}));

import { useProjectPathSearch } from "./queries";

const useComposerPathSearch = (input: Parameters<typeof useProjectPathSearch>[0]) =>
  useProjectPathSearch(input, 20);

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

beforeEach(() => {
  state.session = null;
  state.sessionError = null;
  state.phase = "connected";
});

it("keeps a file search pending until its grant loads, then shows matches", () => {
  expect(useComposerPathSearch(target)).toMatchObject({
    entries: [],
    error: null,
    isPending: true,
  });
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  expect(useComposerPathSearch(target)).toMatchObject({
    entries: [{ path: "src/index.ts", kind: "file" }],
    error: null,
    isPending: false,
  });
});

it("shows a confirmed denial and a connection failure separately", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useComposerPathSearch(target)).toMatchObject({
    entries: [],
    error: "This connection cannot search host files.",
    isPending: false,
  });
  state.session = null;
  state.phase = "offline";
  expect(useComposerPathSearch(target)).toMatchObject({
    entries: [],
    error: "This environment is not connected.",
    isPending: false,
  });
});

it("leaves an inactive search idle while its grant loads", () => {
  expect(useComposerPathSearch({ ...target, cwd: null, query: null })).toMatchObject({
    entries: [],
    error: null,
    isPending: false,
  });
});

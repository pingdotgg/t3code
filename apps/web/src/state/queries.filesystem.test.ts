import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  sessionWaiting: false,
  phase: "connected" as "connected" | "offline",
  sessionAtom: {},
  searchAtom: {},
  contentAtom: {},
  contentRequests: vi.fn(),
  contentError: null as string | null,
  contentData: {
    matches: [{ path: "src/index.ts", lineNumber: 3, lineContent: "a match", matchRanges: [] }],
    truncated: false,
  },
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
  projectContentSearch: (target: unknown) => {
    state.contentRequests(target);
    return state.contentAtom;
  },
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
          : atom === state.contentAtom
            ? state.contentData
            : null,
    error:
      atom === state.sessionAtom
        ? state.sessionError
        : atom === state.contentAtom
          ? state.contentError
          : null,
    isPending:
      atom === state.sessionAtom &&
      (state.sessionWaiting || (state.session === null && state.sessionError === null)),
    refresh: vi.fn(),
  }),
}));

import { useProjectContentSearch, useProjectPathSearch } from "./queries";

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
  state.sessionWaiting = false;
  state.phase = "connected";
  state.contentRequests.mockClear();
  state.contentError = null;
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

const contentTarget = {
  ...target,
  query: " a match ",
  caseSensitive: true,
  wholeWord: true,
  useRegex: false,
};

it("waits for content-search access before issuing a request, including an empty search", () => {
  for (const query of ["", contentTarget.query]) {
    const result = useProjectContentSearch({ ...contentTarget, query });
    expect(state.contentRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      canReadFiles: false,
      isCheckingAccess: true,
      matches: [],
      error: null,
      isPending: true,
    });
  }
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("shows content-search denial before typing and never issues an unauthorized request", () => {
  state.session = { authenticated: true, scopes: [] };
  for (const query of ["", contentTarget.query]) {
    const result = useProjectContentSearch({ ...contentTarget, query });
    expect(state.contentRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      canReadFiles: false,
      isCheckingAccess: false,
      matches: [],
      error: "This connection cannot search host files.",
      isPending: false,
    });
  }
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("preserves content query whitespace and options when access is granted", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  expect(useProjectContentSearch(contentTarget)).toMatchObject({
    matches: state.contentData.matches,
    error: null,
    isPending: false,
  });
  expect(state.contentRequests).toHaveBeenCalledWith({
    environmentId: contentTarget.environmentId,
    input: {
      cwd: contentTarget.cwd,
      query: contentTarget.query,
      limit: 500,
      caseSensitive: true,
      wholeWord: true,
      useRegex: false,
    },
  });
});

it("keeps confirmed content access during revalidation and drops results when it is revoked", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionWaiting = true;
  expect(useProjectContentSearch(contentTarget)).toMatchObject({
    matches: state.contentData.matches,
    isPending: false,
  });

  state.contentRequests.mockClear();
  state.sessionWaiting = false;
  state.session = { authenticated: true, scopes: [] };
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: "This connection cannot search host files.",
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("fails closed after a session check fails, even with a cached grant and matches", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = "The session has expired.";
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: state.sessionError,
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("keeps inactive content search idle and reports a disconnected target without querying", () => {
  expect(
    useProjectContentSearch({ ...contentTarget, environmentId: null, cwd: null }),
  ).toMatchObject({
    matches: [],
    error: null,
    isPending: false,
  });
  state.phase = "offline";
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: "This environment is not connected.",
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});

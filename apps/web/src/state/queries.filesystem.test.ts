import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ProjectSearchContentsError,
  type AuthSessionState,
  type ProjectEntriesFailure,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  sessionWaiting: false,
  phase: "connected" as "connected" | "offline",
  sessionAtom: {},
  searchAtom: {},
  contentAtom: {},
  contentRequests: vi.fn(),
  contentRefresh: vi.fn(),
  contentPending: false,
  contentFailure: null as ProjectSearchContentsError | null,
  effects: [] as Array<() => void | (() => void)>,
  contentError: null as string | null,
  contentData: {
    matches: [{ path: "src/index.ts", lineNumber: 3, lineContent: "a match", matchRanges: [] }],
    truncated: false,
  },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    state.effects.push(effect);
  },
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
    failure: atom === state.contentAtom ? state.contentFailure : null,
    isPending:
      (atom === state.contentAtom && state.contentPending) ||
      (atom === state.sessionAtom &&
        (state.sessionWaiting || (state.session === null && state.sessionError === null))),
    refresh: atom === state.contentAtom ? state.contentRefresh : vi.fn(),
  }),
}));

import { useProjectContentSearch } from "./queries";

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
  state.contentRefresh.mockClear();
  state.contentPending = false;
  state.contentFailure = null;
  state.effects.length = 0;
  state.contentError = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const contentTarget = {
  ...target,
  query: " a match ",
  caseSensitive: true,
  wholeWord: true,
  useRegex: false,
};

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

it("asks again only after a scan timeout has come back, and stops when that changes", () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  const searchFailure = (failure: ProjectEntriesFailure) =>
    new ProjectSearchContentsError({ cwd: "/repo", queryLength: 7, limit: 500, failure });
  // The react mock records effects; this runs one render's effects and returns their cleanup.
  const commit = () => {
    state.effects.length = 0;
    useProjectContentSearch(contentTarget);
    const cleanups = state.effects.map((effect) => effect());
    return () => {
      for (const cleanup of cleanups) cleanup?.();
    };
  };

  state.contentFailure = searchFailure("search_index_scan_timed_out");
  state.contentPending = true;
  let release = commit();
  vi.advanceTimersByTime(60_000);
  expect(state.contentRefresh).not.toHaveBeenCalled();
  release();

  state.contentPending = false;
  release = commit();
  vi.advanceTimersByTime(29_999);
  expect(state.contentRefresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(state.contentRefresh).toHaveBeenCalledTimes(1);
  release();

  release = commit();
  release();
  vi.advanceTimersByTime(60_000);
  expect(state.contentRefresh).toHaveBeenCalledTimes(1);

  for (const failure of [null, searchFailure("search_index_search_failed")]) {
    state.contentFailure = failure;
    release = commit();
    vi.advanceTimersByTime(60_000);
    release();
  }
  expect(state.contentRefresh).toHaveBeenCalledTimes(1);
});

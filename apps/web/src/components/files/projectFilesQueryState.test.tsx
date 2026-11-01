import {
  AuthFilesystemReadScope,
  EnvironmentId,
  type AuthSessionState,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const authorizationMocks = vi.hoisted(() => ({
  sessionAtom: null as Atom.Atom<
    AsyncResult.AsyncResult<Pick<AuthSessionState, "authenticated" | "scopes">, Error>
  > | null,
  phase: "connected" as "connected" | "offline",
}));

vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => authorizationMocks.sessionAtom },
}));

vi.mock("~/state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: authorizationMocks.phase, error: null } },
  }),
}));

const projectMocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  optimisticFile: vi.fn(),
  readFile: vi.fn(),
}));

const atomHooks = vi.hoisted(() => ({
  registry: null as {
    get(atom: object): unknown;
    refresh(atom: object): void;
  } | null,
}));

const reactHooks = vi.hoisted(() => {
  let cursor = 0;
  let refs: Array<{ current: unknown }> = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      refs = [];
    },
    useCallback<A>(callback: A): A {
      nextIndex();
      return callback;
    },
    useEffect(effect: () => void): void {
      nextIndex();
      effect();
    },
    useRef<A>(initialValue: A): { current: A } {
      const index = nextIndex();
      refs[index] ??= { current: initialValue };
      return refs[index] as { current: A };
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: (atom: object) => () => {
    atomHooks.registry?.refresh(atom);
  },
  useAtomValue: (atom: object) => atomHooks.registry?.get(atom),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: reactHooks.useCallback,
    useEffect: reactHooks.useEffect,
    useMemo: <A,>(factory: () => A) => factory(),
    useRef: reactHooks.useRef,
  };
});

vi.mock("~/state/projects", () => ({
  projectEnvironment: projectMocks,
}));

vi.mock("~/state/queries", () => ({
  useProjectPathSearch: vi.fn(),
}));

import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useProjectEntriesQuery, useProjectFileQuery } from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-1");

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function file(contents: string): ProjectReadFileResult {
  return {
    relativePath: "src/preview.ts",
    contents,
    byteLength: contents.length,
    truncated: false,
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("project query refresh", () => {
  beforeEach(() => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
    );
    authorizationMocks.phase = "connected";
    projectMocks.listEntries.mockReset();
    projectMocks.optimisticFile.mockReset();
    projectMocks.readFile.mockReset();
    reactHooks.reset();
  });

  it("does not query or expose optimistic file contents without read permission", () => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [] }),
    );
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.optimisticFile.mockReturnValue(Atom.make({ data: file("cached contents") }));
    try {
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(query.data).toBeNull();
      expect(query.error).toBe("This connection cannot read host files.");
      expect(query.isPending).toBe(false);
      const entries = useProjectEntriesQuery(environmentId, "/repo");
      expect(projectMocks.listEntries).not.toHaveBeenCalled();
      expect(entries.data).toBeNull();
      expect(entries.error).toBe("This connection cannot read host files.");
      expect(entries.isPending).toBe(false);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("refetches a listing when the workspace mutation changes, not when it is first read", async () => {
    let fetches = 0;
    const listing = Atom.make(() => {
      fetches += 1;
      return AsyncResult.success({ entries: [], truncated: false });
    }).pipe(Atom.keepAlive);
    projectMocks.listEntries.mockReturnValue(listing);
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    const read = (mutationId: string | null) =>
      useProjectEntriesQuery(environmentId, "/repo", "src", mutationId);

    try {
      read("mutation-1");
      read("mutation-1");
      expect(fetches).toBe(1);

      read("mutation-2");
      // The refetch runs after the render that read the new revision; a reader that is not
      // subscribed sees it on its next read.
      await Promise.resolve();
      read("mutation-2");
      expect(fetches).toBe(2);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("replaces an in-flight initial read when a workspace mutation arrives", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectReadFileResult>>> = [];
    const readAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectReadFileResult>();
        requests.push(request);
        return request.promise;
      }),
    ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;
    let renderedContents: string | null = null;

    const render = (mutationId: string | null) => {
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(query.readError).toBeNull();
      renderedContents = query.data?.contents ?? null;
      useWorkspaceMutationRefresh({
        mutationId,
        refresh: query.refresh,
        resourceKey: "file:environment-1:/repo:src/preview.ts",
      });
    };

    try {
      render(null);
      await flushEffects();
      expect(requests).toHaveLength(1);

      render("mutation-1");
      await flushEffects();
      expect(requests).toHaveLength(2);

      requests[1]!.resolve(file("fresh"));
      await flushEffects();
      render("mutation-1");
      expect(renderedContents).toBe("fresh");

      requests[0]!.resolve(file("stale"));
      await flushEffects();
      render("mutation-1");
      expect(renderedContents).toBe("fresh");
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("confirms files from reads and preserves that identity until a definitive folder result", () => {
    const contents = file("# readme");
    const success = AsyncResult.success(contents);
    const failure = (kind: ProjectReadFileError["failure"], cached = false) =>
      AsyncResult.failure(
        Cause.fail(
          new ProjectReadFileError({ cwd: "/repo", relativePath: "src/preview.ts", failure: kind }),
        ),
        { previousSuccess: cached ? Option.some(success) : Option.none() },
      );
    const states = [
      ["initial read", AsyncResult.initial(true), false, false, null],
      ["unknown path", failure("operation_failed"), false, false, null],
      ["binary file", failure("binary_file"), true, false, null],
      ["read success", success, true, false, contents],
      ["pending refresh", AsyncResult.waiting(success), true, false, contents],
      ["transient refresh failure", failure("operation_failed", true), true, false, contents],
      ["became a folder", failure("path_not_file", true), false, true, contents],
    ] as const;
    const readAtom = Atom.make<
      AsyncResult.AsyncResult<ProjectReadFileResult, ProjectReadFileError>
    >(AsyncResult.initial(true));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;

    try {
      for (const [label, result, isFile, isNotFile, data] of states) {
        registry.set(readAtom, result);
        reactHooks.beginRender();
        const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
        expect(query.isFile, label).toBe(isFile);
        expect(query.isNotFile, label).toBe(isNotFile);
        expect(query.data, label).toBe(data);
        expect(query.isPending, label).toBe(result.waiting);
      }
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });
});

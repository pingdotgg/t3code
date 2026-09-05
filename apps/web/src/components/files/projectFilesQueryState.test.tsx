import {
  AuthFilesystemReadScope,
  EnvironmentId,
  type AuthSessionState,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
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
import { useT3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";
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

function projectEntries(paths: readonly string[]): ProjectListEntriesResult {
  return {
    entries: paths.map((path) => ({ path, kind: "file" })),
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

  it("keeps t3.json and the file tree loading until the file grant arrives", () => {
    authorizationMocks.sessionAtom = Atom.make(AsyncResult.initial());
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    const config = {
      defaultThreadEnvMode: "worktree",
      scripts: [{ name: "Test", command: "vp test" }],
    };
    projectMocks.readFile.mockReturnValue(
      Atom.make(AsyncResult.success(file(JSON.stringify(config)))),
    );
    projectMocks.listEntries.mockReturnValue(
      Atom.make(AsyncResult.success(projectEntries(["t3.json"]))),
    );
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    try {
      expect(useProjectFileQuery(environmentId, "/repo", "t3.json")).toMatchObject({
        data: null,
        error: null,
        isPending: true,
      });
      expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject({
        data: null,
        error: null,
        isPending: true,
      });
      expect(useT3ProjectFileState(environmentId, "/repo").status).toBe("loading");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(projectMocks.listEntries).not.toHaveBeenCalled();

      authorizationMocks.sessionAtom = Atom.make(
        AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
      );
      expect(useT3ProjectFileState(environmentId, "/repo")).toEqual({
        status: "valid",
        file: config,
        scripts: config.scripts,
      });
      expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject({
        data: projectEntries(["t3.json"]),
        error: null,
        isPending: false,
      });
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it.each(["connected", "offline"] as const)(
    "preserves cached t3.json defaults and scripts during a granted refresh while %s",
    (phase) => {
      authorizationMocks.phase = phase;
      authorizationMocks.sessionAtom = Atom.make(
        AsyncResult.success(
          { authenticated: true, scopes: [AuthFilesystemReadScope] },
          { waiting: true },
        ),
      );
      const registry = AtomRegistry.make();
      atomHooks.registry = registry;
      const config = {
        defaultThreadEnvMode: "worktree",
        scripts: [{ name: "Test", command: "vp test" }],
      };
      projectMocks.readFile.mockReturnValue(
        Atom.make(AsyncResult.success(file(JSON.stringify(config)), { waiting: true })),
      );
      projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
      try {
        expect(useProjectFileQuery(environmentId, "/repo", "t3.json")).toMatchObject({
          error: null,
          isPending: true,
        });
        expect(useT3ProjectFileState(environmentId, "/repo")).toEqual({
          status: "valid",
          file: config,
          scripts: config.scripts,
        });
      } finally {
        registry.dispose();
        atomHooks.registry = null;
      }
    },
  );

  it.each([
    { phase: "connected", sessionError: "The session request timed out." },
    { phase: "offline", sessionError: null },
  ] as const)(
    "reports unavailable file access for $phase connections",
    ({ phase, sessionError }) => {
      authorizationMocks.phase = phase;
      authorizationMocks.sessionAtom = Atom.make(
        sessionError === null
          ? AsyncResult.initial()
          : AsyncResult.failure(Cause.fail(new Error(sessionError))),
      );
      const registry = AtomRegistry.make();
      atomHooks.registry = registry;
      projectMocks.optimisticFile.mockReturnValue(Atom.make({ data: file("cached contents") }));
      try {
        const unavailable = {
          data: null,
          error: sessionError ?? "This environment is not connected.",
          isPending: false,
        };
        expect(useProjectFileQuery(environmentId, "/repo", "src/preview.ts")).toMatchObject(
          unavailable,
        );
        expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject(unavailable);
        expect(projectMocks.readFile).not.toHaveBeenCalled();
        expect(projectMocks.listEntries).not.toHaveBeenCalled();
      } finally {
        registry.dispose();
        atomHooks.registry = null;
      }
    },
  );

  it("leaves disabled file queries idle while the file grant loads", () => {
    authorizationMocks.sessionAtom = Atom.make(AsyncResult.initial());
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    try {
      expect(useProjectFileQuery(environmentId, "/repo", "t3.json", false)).toMatchObject({
        data: null,
        error: null,
        isPending: false,
      });
      expect(useT3ProjectFileState(environmentId, null).status).toBe("missing");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
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

  it("revalidates cached entries when a workspace mutation is observed after mounting", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectListEntriesResult>>> = [];
    const entriesAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectListEntriesResult>();
        requests.push(request);
        return request.promise;
      }),
    ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(entriesAtom);
    projectMocks.listEntries.mockReturnValue(entriesAtom);
    atomHooks.registry = registry;
    let renderedPaths: readonly string[] = [];

    const render = (mutationId: string | null) => {
      reactHooks.beginRender();
      const query = useProjectEntriesQuery(environmentId, "/repo");
      renderedPaths = query.data?.entries.map((entry) => entry.path) ?? [];
      useWorkspaceMutationRefresh({
        mutationId,
        refresh: query.refresh,
        resourceKey: "files:environment-1:/repo",
      });
    };

    try {
      await flushEffects();
      expect(requests).toHaveLength(1);
      requests[0]!.resolve(projectEntries(["src/old.ts"]));
      await flushEffects();

      render("mutation-1");
      expect(renderedPaths).toEqual(["src/old.ts"]);
      await flushEffects();
      expect(requests).toHaveLength(2);

      requests[1]!.resolve(projectEntries(["src/new.ts"]));
      await flushEffects();
      render("mutation-1");
      expect(renderedPaths).toEqual(["src/new.ts"]);
      expect(requests).toHaveLength(2);
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("does not issue a file read for a disabled image preview", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectReadFileResult>>> = [];
    const readAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectReadFileResult>();
        requests.push(request);
        return request.promise;
      }),
    );
    const registry = AtomRegistry.make();
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;

    try {
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "preview.png", false);
      useWorkspaceMutationRefresh({
        enabled: false,
        mutationId: "mutation-1",
        refresh: query.refresh,
        resourceKey: "file:environment-1:/repo:preview.png",
      });
      await flushEffects();

      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });
});

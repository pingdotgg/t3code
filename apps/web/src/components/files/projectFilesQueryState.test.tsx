import {
  EnvironmentId,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
    projectMocks.listEntries.mockReset();
    projectMocks.optimisticFile.mockReset();
    projectMocks.readFile.mockReset();
    reactHooks.reset();
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

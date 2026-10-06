import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";

const project = scopeProjectRef(EnvironmentId.make("env-a"), ProjectId.make("project-a"));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("restores explicit selections after remounting and isolates projects and environments", async () => {
  const entries = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    },
    dispatchEvent: () => true,
  });
  let usePreference = (await import("./worktreePreferences")).useLastWorktreeBaseBranch;
  const observe = vi.fn<(branch: string | null, select: (branch: string) => void) => void>();
  function Composer({ projectRef }: { projectRef: ScopedProjectRef }) {
    const [selected, selectBranch] = usePreference(projectRef);
    observe(selected, selectBranch);
    return null;
  }
  renderToString(<Composer projectRef={project} />);
  expect(observe.mock.lastCall?.[0]).toBeNull();
  observe.mock.lastCall?.[1]("dev");
  vi.resetModules();
  usePreference = (await import("./worktreePreferences")).useLastWorktreeBaseBranch;
  renderToString(<Composer projectRef={project} />);
  expect(observe.mock.lastCall?.[0]).toBe("dev");
  renderToString(
    <Composer projectRef={scopeProjectRef(project.environmentId, ProjectId.make("project-b"))} />,
  );
  expect(observe.mock.lastCall?.[0]).toBeNull();
  renderToString(
    <Composer projectRef={scopeProjectRef(EnvironmentId.make("env-b"), project.projectId)} />,
  );
  expect(observe.mock.lastCall?.[0]).toBeNull();
});

import type { EnvironmentId, ProjectId, WorkItemMatch } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useWorkItemMatches } from "./WorkItemMatches";

const { run, toast, permission } = vi.hoisted(() => ({
  run: vi.fn(),
  toast: vi.fn(),
  permission: { allowed: true, target: null as unknown },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => run }));
vi.mock("~/state/workItems", () => ({
  findWorkItemMatches: { permissionAtom: (target: unknown) => target },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (target: unknown) => {
    permission.target = target;
    return permission.allowed;
  },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));

let renderer: ReactTestRenderer;
let result: ReturnType<typeof useWorkItemMatches>;
const source = { kind: "issue" as const, repository: "acme/app", number: 12 };

function Probe({ version }: { version: string }) {
  const matches = useWorkItemMatches({
    environmentId: "local" as EnvironmentId,
    projectId: "project-a" as ProjectId,
    source,
    version,
  });
  useLayoutEffect(() => {
    result = matches;
  });
  return null;
}

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  permission.allowed = true;
  run.mockReset();
});

it("reports a changed item during a search and allows a fresh search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  type Response = { _tag: "Success"; value: { matches: WorkItemMatch[] } };
  let resolve!: (value: Response) => void;
  const response = new Promise<Response>((done) => {
    resolve = done;
  });
  run.mockReturnValueOnce(response);
  await act(() => {
    renderer = create(<Probe version="one" />);
  });
  let search: Promise<void>;
  await act(() => {
    search = result.find("related");
  });
  expect(result.pending).toBe("related");
  await act(() => renderer.update(<Probe version="two" />));
  await act(async () => {
    resolve({ _tag: "Success", value: { matches: [] } });
    await search;
  });
  expect(result.pending).toBeNull();
  expect(result.related).toBeUndefined();
  expect(toast).toHaveBeenCalledWith({
    type: "error",
    title: "This item changed. Find matches again.",
  });

  run.mockResolvedValueOnce({ _tag: "Success", value: { matches: [] } });
  await act(() => result.find("related"));
  expect(result.related).toEqual([]);
  expect(result.pending).toBeNull();
});

it("does not search without operate permission on the destination environment", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  permission.allowed = false;
  await act(() => {
    renderer = create(<Probe version="one" />);
  });
  expect(permission.target).toBe("local");
  expect(result.allowed).toBe(false);
  await act(() => result.find("related"));
  expect(run).not.toHaveBeenCalled();
  expect(result.pending).toBeNull();
});

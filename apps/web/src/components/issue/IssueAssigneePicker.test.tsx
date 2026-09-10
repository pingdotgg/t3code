import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { IssueAssigneePicker } from "./IssueAssigneePicker";

const { setAssignees, refresh } = vi.hoisted(() => ({
  setAssignees: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => setAssignees }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      truncated: true,
      candidates: [
        { id: "1", login: "ada", isAssigned: true },
        { id: "2", login: "grace", isAssigned: false },
      ],
    },
    error: null,
    isPending: false,
    refresh,
  }),
}));
vi.mock("../sourceControl/EntityPicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sourceControl/EntityPicker")>()),
  EntityPicker: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../sourceControl/actorPresentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sourceControl/actorPresentation")>()),
  SourceControlActorLabel: () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("assigns from a truncated list without removing current assignees", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolve!: (value: { _tag: "Success" }) => void;
  const response = new Promise<{ _tag: "Success" }>((done) => {
    resolve = done;
  });
  setAssignees.mockReturnValueOnce(response);
  const environmentId = "local" as EnvironmentId;
  const reference = { projectId: "project-a" as ProjectId, repository: "acme/app", number: 12 };
  const onChanged = vi.fn();
  await act(() => {
    renderer = create(
      <IssueAssigneePicker
        environmentId={environmentId}
        reference={reference}
        allowed
        open
        onOpenChange={vi.fn()}
        onChanged={onChanged}
      />,
    );
  });
  const option = renderer.root.findAllByType("button")[1]!;
  expect(option.props.disabled).toBe(false);
  await act(() => option.props.onClick());
  expect(setAssignees).toHaveBeenCalledWith({
    environmentId,
    input: { ...reference, assignees: ["1", "2"] },
  });
  expect(renderer.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  await act(async () => {
    resolve({ _tag: "Success" });
    await response;
  });
  expect(onChanged).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

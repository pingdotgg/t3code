import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { IssueAssigneePicker } from "./IssueAssigneePicker";

const { setAssignees, refresh, query } = vi.hoisted(() => ({
  setAssignees: vi.fn(),
  refresh: vi.fn(),
  query: {
    data: null as unknown,
    dataUpdatedAt: 0,
    isPending: false,
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => setAssignees }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ ...query, error: null, refresh }),
}));
vi.mock("../pullRequest/PullRequestCandidatePicker", () => ({
  PullRequestCandidatePicker: <T,>(props: {
    candidates: ReadonlyArray<T>;
    disabled: boolean;
    candidateKey: (candidate: T) => string;
    onSelect: (candidate: T) => void;
    children: (candidate: T) => ReactNode;
  }) => (
    <div>
      {props.candidates.map((candidate) => (
        <button
          key={props.candidateKey(candidate)}
          type="button"
          disabled={props.disabled}
          onClick={() => props.onSelect(candidate)}
        >
          {props.children(candidate)}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../pullRequest/pullRequestPresentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pullRequest/pullRequestPresentation")>()),
  PullRequestActorLabel: () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

let renderer: ReactTestRenderer;
beforeEach(() => {
  query.data = {
    truncated: true,
    candidates: [
      { id: "1", login: "ada", isAssigned: true },
      { id: "2", login: "grace", isAssigned: false },
      { id: "3", login: "linus", isAssigned: true },
    ],
  };
  query.dataUpdatedAt = 1;
  query.isPending = false;
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const environmentId = "local" as EnvironmentId;
const reference = { projectId: "project-a" as ProjectId, repository: "acme/app", number: 12 };
const picker = () => (
  <IssueAssigneePicker
    environmentId={environmentId}
    reference={reference}
    allowed
    open
    onOpenChange={vi.fn()}
    onChanged={vi.fn()}
  />
);
const checked = () =>
  renderer.root
    .findAllByType("button")
    .map(
      (button) =>
        button.findAll((node) => node.props["aria-label"] === "Already assigned").length > 0,
    );

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
    input: { ...reference, assignees: ["1", "3", "2"] },
  });
  expect(renderer.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  await act(async () => {
    resolve({ _tag: "Success" });
    await response;
  });
  expect(onChanged).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

it("builds each write on the last written assignees until the refresh lands", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(picker());
  });
  const click = (index: number) =>
    act(async () => {
      await renderer.root.findAllByType("button")[index]!.props.onClick();
    });

  setAssignees.mockResolvedValueOnce({ _tag: "Success" });
  query.isPending = true;
  await click(1);
  expect(setAssignees).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, assignees: ["1", "3", "2"] },
  });
  expect(checked()).toEqual([true, true, true]);

  setAssignees.mockResolvedValueOnce({ _tag: "Success" });
  await click(0);
  expect(setAssignees).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, assignees: ["2", "3"] },
  });
  expect(checked()).toEqual([false, true, true]);

  setAssignees.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("refused")) });
  await click(2);
  expect(setAssignees).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, assignees: ["2"] },
  });
  expect(checked()).toEqual([false, true, true]);
  expect(refresh).toHaveBeenCalledTimes(2);

  query.data = {
    truncated: true,
    candidates: [
      { id: "1", login: "ada", isAssigned: false },
      { id: "2", login: "grace", isAssigned: true },
      { id: "3", login: "linus", isAssigned: false },
    ],
  };
  query.dataUpdatedAt = Date.now() + 1;
  query.isPending = false;
  await act(() => renderer.update(picker()));
  expect(checked()).toEqual([false, true, false]);
});

it("ignores a second choice while a write is in flight", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setAssignees.mockReturnValueOnce(new Promise(() => undefined));
  await act(() => {
    renderer = create(picker());
  });
  const [ada, grace] = renderer.root.findAllByType("button");
  act(() => {
    grace!.props.onClick();
    ada!.props.onClick();
  });
  expect(setAssignees).toHaveBeenCalledOnce();
});

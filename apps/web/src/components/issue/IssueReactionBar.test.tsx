// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { IssueReactionBar } from "./IssueDetailPanel";

const state = vi.hoisted(() => ({ react: vi.fn(), toast: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.react }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));

const environmentId = EnvironmentId.make("environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "42",
};
const reactions = [
  { content: "thumbs-up" as const, count: 2, actors: [], viewerHasReacted: false },
];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([undefined, "latest-comment", "held-older-comment"])(
  "retains a successful add when a reverse write fails with stale native data (%s)",
  async (subjectId) => {
    state.react
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success" });
    await act(async () =>
      root.render(
        <IssueReactionBar
          viewer="viewer"
          reactions={reactions}
          canReact
          contents={undefined}
          environmentId={environmentId}
          reference={reference}
          subjectId={subjectId}
        />,
      ),
    );
    const pill = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().textContent).toContain("3");
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().textContent).toContain("3");
    await act(async () => pill().click());
    expect(pill().getAttribute("aria-pressed")).toBe("false");
    expect(pill().textContent).toContain("2");
    expect(state.react.mock.calls.map(([target]) => target.input.reacted)).toEqual([
      true,
      false,
      false,
    ]);
    for (const [target] of state.react.mock.calls)
      expect(target).toEqual({
        environmentId,
        input: {
          ...reference,
          ...(subjectId === undefined ? {} : { subjectId }),
          content: "thumbs-up",
          reacted: target.input.reacted,
        },
      });
  },
);

it.each([
  { canReact: false, contents: undefined },
  { canReact: true, contents: [] },
  { canReact: true, contents: ["heart" as const] },
])("keeps unsupported reaction counts read-only for %j", async ({ canReact, contents }) => {
  await act(async () =>
    root.render(
      <IssueReactionBar
        viewer="viewer"
        reactions={reactions}
        canReact={canReact}
        contents={contents}
        environmentId={environmentId}
        reference={reference}
      />,
    ),
  );
  const pill = container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
  expect(pill.disabled).toBe(true);
  await act(async () => pill.click());
  expect(state.react).not.toHaveBeenCalled();
  expect(pill.textContent).toContain("2");
});

it.each(
  [undefined, "latest-comment", "held-older-comment"].flatMap((subjectId) =>
    ["viewer", null].flatMap((viewer) =>
      [false, true].map((reacted) => ({ subjectId, viewer, reacted })),
    ),
  ),
)(
  "trusts refreshed unknown-owner reactions but keeps cached choices: %j",
  async ({ subjectId, viewer, reacted }) => {
    state.react.mockResolvedValue({ _tag: "Success" });
    const native = [{ ...reactions[0]!, viewerHasReacted: !reacted }];
    const render = (value: typeof native) =>
      root.render(
        <IssueReactionBar
          viewer={viewer}
          reactions={value}
          canReact
          contents={undefined}
          environmentId={environmentId}
          reference={reference}
          subjectId={subjectId}
        />,
      );
    const pill = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
    await act(async () => render(native));
    await act(async () => pill().click());
    const optimisticCount = reacted ? "3" : "1";
    expect(pill().textContent).toContain(optimisticCount);
    await act(async () => render(native));
    expect(pill().textContent).toContain(optimisticCount);
    await act(async () => render([...native]));
    expect(pill().textContent).toContain(viewer === null ? "2" : optimisticCount);
    expect(pill().getAttribute("aria-pressed")).toBe(String(viewer === null ? !reacted : reacted));
    await act(async () => pill().click());
    expect(state.react.mock.calls.map(([target]) => target.input.reacted)).toEqual([
      reacted,
      viewer === null ? reacted : !reacted,
    ]);
  },
);

it("does not restore an unknown owner's old choice after a late reverse failure", async () => {
  let fail!: (value: { _tag: "Failure" }) => void;
  const reverse = new Promise<{ _tag: "Failure" }>((resolve) => {
    fail = resolve;
  });
  state.react.mockResolvedValueOnce({ _tag: "Success" }).mockReturnValueOnce(reverse);
  const render = (value: typeof reactions) =>
    root.render(
      <IssueReactionBar
        viewer={null}
        reactions={value}
        canReact
        contents={undefined}
        environmentId={environmentId}
        reference={reference}
      />,
    );
  const pill = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
  await act(async () => render(reactions));
  await act(async () => pill().click());
  await act(async () => pill().click());
  await act(async () => render([...reactions]));
  await act(async () => fail({ _tag: "Failure" }));
  expect(pill().getAttribute("aria-pressed")).toBe("false");
  expect(pill().textContent).toContain("2");
  expect(state.react).toHaveBeenCalledTimes(2);
});

it("does not treat missing comment reactions as a fresh native empty array", async () => {
  state.react.mockResolvedValue({ _tag: "Success" });
  const render = (value: typeof reactions | undefined) =>
    root.render(
      <IssueReactionBar
        viewer={null}
        reactions={value}
        canReact
        contents={undefined}
        environmentId={environmentId}
        reference={reference}
        subjectId="comment"
      />,
    );
  const pill = () => container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]');
  await act(async () => render(reactions));
  await act(async () => pill()!.click());
  await act(async () => render(undefined));
  await act(async () => render(undefined));
  expect(pill()?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => render([]));
  expect(pill()).toBeNull();
  expect(state.react).toHaveBeenCalledTimes(1);
});

it("keeps picker selection, keyboard focus and Escape dismissal", async () => {
  state.react.mockResolvedValue({ _tag: "Success" });
  await act(async () =>
    root.render(
      <IssueReactionBar
        viewer="viewer"
        reactions={reactions}
        canReact
        contents={["thumbs-up", "heart"]}
        environmentId={environmentId}
        reference={reference}
      />,
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add a reaction"]')!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    trigger.click();
    trigger.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  const choice = document.querySelector<HTMLButtonElement>('button[aria-label="thumbs up"]')!;
  expect(choice).not.toBeNull();
  expect(choice.getAttribute("aria-pressed")).toBe("false");
  await act(async () => choice.click());
  const pill = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
  expect(pill().getAttribute("aria-pressed")).toBe("true");
  expect(pill().textContent).toContain("3");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => trigger.click());
  const selected = document.querySelector<HTMLButtonElement>('button[aria-label="thumbs up"]')!;
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    selected.focus();
    selected.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  expect(state.react).toHaveBeenCalledTimes(1);
  await act(async () => pill().click());
  expect(pill().getAttribute("aria-pressed")).toBe("false");
  expect(pill().textContent).toContain("2");
  expect(state.react.mock.calls.map(([target]) => target.input.reacted)).toEqual([true, false]);
});

it.each([undefined, "latest-comment", "held-older-comment"])(
  "disables both controls for a pending reaction and rolls back failure (%s)",
  async (subjectId) => {
    let finish!: (value: { _tag: "Failure" }) => void;
    state.react.mockReturnValueOnce(
      new Promise<{ _tag: "Failure" }>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <IssueReactionBar
          viewer="viewer"
          reactions={reactions}
          canReact
          contents={["thumbs-up"]}
          environmentId={environmentId}
          reference={reference}
          subjectId={subjectId}
        />,
      ),
    );
    const pill = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="thumbs up,"]')!;
    await act(async () => pill().click());
    expect(pill().disabled).toBe(true);
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(pill().textContent).toContain("3");
    await act(async () => pill().click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Add a reaction"]')!.click(),
    );
    const choice = document.querySelector<HTMLButtonElement>('button[aria-label="thumbs up"]')!;
    expect(choice.disabled).toBe(true);
    await act(async () => choice.click());
    expect(state.react).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        ...reference,
        ...(subjectId === undefined ? {} : { subjectId }),
        content: "thumbs-up",
        reacted: true,
      },
    });
    await act(async () => finish({ _tag: "Failure" }));
    expect(pill().disabled).toBe(false);
    expect(choice.disabled).toBe(false);
    expect(pill().getAttribute("aria-pressed")).toBe("false");
    expect(pill().textContent).toContain("2");
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "The reaction could not be saved",
    });
  },
);

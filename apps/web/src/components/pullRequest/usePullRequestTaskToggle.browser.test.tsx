import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { usePullRequestTaskToggle } from "./usePullRequestTaskToggle";

const BODY = "- [ ] a\n- [ ] b";
const MARKER_A = BODY.indexOf("[");
const MARKER_B = BODY.lastIndexOf("[");

function Harness({
  body = BODY,
  save,
  onSettled,
}: {
  body?: string;
  save: (body: string) => Promise<boolean>;
  onSettled: () => void;
}) {
  const tasks = usePullRequestTaskToggle(body, save, onSettled);
  return (
    <div>
      <pre data-testid="text">{tasks.text}</pre>
      <button onClick={() => tasks.onTaskListChange?.({ markerOffset: MARKER_A, checked: true })}>
        A
      </button>
      <button onClick={() => tasks.onTaskListChange?.({ markerOffset: MARKER_B, checked: true })}>
        B
      </button>
    </div>
  );
}

function controlledSave() {
  const calls: Array<{ body: string; finish: (saved: boolean) => void }> = [];
  const save = vi.fn(
    (body: string) =>
      new Promise<boolean>((finish) => {
        calls.push({ body, finish });
      }),
  );
  return { calls, save };
}

describe("usePullRequestTaskToggle", () => {
  it("saves quick toggles one at a time, in click order, and refreshes once", async () => {
    const { calls, save } = controlledSave();
    const onSettled = vi.fn();
    await using screen = await render(<Harness save={save} onSettled={onSettled} />, {
      router: false, // The harness renders no links.
    });

    await userEvent.click(screen.getByRole("button", { name: "A" }));
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    await expect.element(screen.getByTestId("text")).toHaveTextContent("- [x] a - [x] b");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    calls[0]!.finish(true);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => call.body)).toEqual(["- [x] a\n- [ ] b", "- [x] a\n- [x] b"]);
    expect(onSettled).not.toHaveBeenCalled();

    calls[1]!.finish(true);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  it("cancels saves queued behind a failed one and shows the host's copy", async () => {
    const { calls, save } = controlledSave();
    const onSettled = vi.fn();
    await using screen = await render(<Harness save={save} onSettled={onSettled} />, {
      router: false, // The harness renders no links.
    });

    await userEvent.click(screen.getByRole("button", { name: "A" }));
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    calls[0]!.finish(false);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByTestId("text")).toHaveTextContent("- [ ] a - [ ] b");
  });

  it("forgets a saved burst once the host's copy moves on, even if it later reverts", async () => {
    const { calls, save } = controlledSave();
    const onSettled = vi.fn();
    await using screen = await render(<Harness save={save} onSettled={onSettled} />, {
      router: false, // The harness renders no links.
    });

    await userEvent.click(screen.getByRole("button", { name: "A" }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.finish(true);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    await screen.rerender(<Harness body={calls[0]!.body} save={save} onSettled={onSettled} />);
    await screen.rerender(<Harness body={BODY} save={save} onSettled={onSettled} />);
    await expect.element(screen.getByTestId("text")).toHaveTextContent("- [ ] a - [ ] b");
  });
});

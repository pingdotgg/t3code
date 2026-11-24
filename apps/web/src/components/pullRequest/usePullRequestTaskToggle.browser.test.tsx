import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { usePullRequestTaskToggle } from "./usePullRequestTaskToggle";

const BODY = "- [ ] a\n- [ ] b";

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
      <button
        onClick={() => tasks.onTaskListChange?.({ markerOffset: BODY.indexOf("["), checked: true })}
      >
        A
      </button>
      <button
        onClick={() =>
          tasks.onTaskListChange?.({ markerOffset: BODY.lastIndexOf("["), checked: true })
        }
      >
        B
      </button>
    </div>
  );
}

function heldSaves() {
  const calls: Array<{ body: string; finish: (saved: boolean) => void }> = [];
  const save = vi.fn(
    (body: string) => new Promise<boolean>((finish) => void calls.push({ body, finish })),
  );
  return { calls, save };
}

describe("usePullRequestTaskToggle", () => {
  it("saves quick ticks one at a time, in click order, and refreshes once", async () => {
    const { calls, save } = heldSaves();
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

  it("drops ticks queued behind a failed save and shows the host's copy", async () => {
    const { calls, save } = heldSaves();
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
});

import { describe, expect, it } from "vite-plus/test";
import { nextThreadFindAnnouncement, type ThreadFindAnnouncement } from "./threadFind";

type Step = Omit<ThreadFindAnnouncement, "failed"> & { readonly failed?: boolean };

function replay(steps: readonly Step[]) {
  let current: ThreadFindAnnouncement | null = null;
  const spoken: string[] = [];
  for (const step of steps) {
    const next = nextThreadFindAnnouncement(current, { failed: false, ...step });
    if (next.text !== (current?.text ?? "")) spoken.push(next.text);
    current = next;
  }
  return spoken;
}

describe("nextThreadFindAnnouncement", () => {
  it("speaks each settled search or step once and stays silent through streamed refreshes", () => {
    expect(
      replay([
        { navigationId: 1, text: "Searching…", settled: false },
        { navigationId: 1, text: "1/…", settled: false },
        { navigationId: 1, text: "1/3", settled: true },
        { navigationId: 1, text: "1/…", settled: false },
        { navigationId: 1, text: "1/4", settled: true },
        { navigationId: 2, text: "1/4", settled: false },
        { navigationId: 2, text: "2/4", settled: true },
        { navigationId: 2, text: "2/5", settled: true },
      ]),
    ).toEqual(["1/3", "2/4"]);
  });

  it("speaks a failure and the result of retrying it", () => {
    expect(
      replay([
        { navigationId: 1, text: "Search failed", settled: true, failed: true },
        { navigationId: 1, text: "1/3", settled: true },
        { navigationId: 1, text: "1/4", settled: true },
      ]),
    ).toEqual(["Search failed", "1/3"]);
  });
});

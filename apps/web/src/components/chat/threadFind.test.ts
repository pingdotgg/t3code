import { describe, expect, it } from "vite-plus/test";
import { nextThreadFindAnnouncement, type ThreadFindAnnouncement } from "./threadFind";

function replay(steps: readonly ThreadFindAnnouncement[]) {
  let current: ThreadFindAnnouncement | null = null;
  const spoken: string[] = [];
  for (const step of steps) {
    const next = nextThreadFindAnnouncement(current, step);
    if (next.text !== current?.text) spoken.push(next.text);
    current = next;
  }
  return spoken;
}

describe("nextThreadFindAnnouncement", () => {
  it("speaks a search as it settles and stays silent through streamed refreshes", () => {
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
    ).toEqual(["Searching…", "1/…", "1/3", "1/4", "2/4"]);
  });
});

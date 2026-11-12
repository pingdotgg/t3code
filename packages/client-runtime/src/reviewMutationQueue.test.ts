import { describe, expect, it } from "vite-plus/test";
import { OptimisticReviewMutationQueue } from "./reviewMutationQueue.ts";

function gate() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("optimistic staging queue", () => {
  it("projects later clicks while the first Git write is delayed and writes in order", async () => {
    const first = gate();
    const sent: number[] = [];
    const seen: Array<[number, number]> = [];
    const queue = new OptimisticReviewMutationQueue(0, {
      apply: (value, delta: number) => value + delta,
      send: async (delta) => {
        sent.push(delta);
        return delta === 2 ? first.promise : true;
      },
      onSnapshot: (value, pending) => seen.push([value, pending]),
      onFailure: () => {
        throw new Error("unexpected failure");
      },
    });
    queue.enqueue(2);
    queue.enqueue(5);
    expect(sent).toEqual([2]);
    expect(seen.at(-1)).toEqual([7, 2]);
    first.resolve(true);
    await queue.settled();
    expect(sent).toEqual([2, 5]);
    expect(seen.at(-1)).toEqual([7, 0]);
  });

  it("rolls back a failed write while retaining subsequent selected files and remains usable", async () => {
    const first = gate();
    const snapshots: string[][] = [];
    const failures: string[] = [];
    const queue = new OptimisticReviewMutationQueue<string[], string>([], {
      apply: (files, file) => [...files, file],
      send: (file) => (file === "failed.ts" ? first.promise : Promise.resolve(true)),
      onSnapshot: (files) => snapshots.push(files),
      onFailure: (file) => failures.push(file),
    });
    queue.enqueue("failed.ts");
    queue.enqueue("next.ts");
    expect(snapshots.at(-1)).toEqual(["failed.ts", "next.ts"]);
    first.resolve(false);
    await queue.settled();
    expect(snapshots.at(-1)).toEqual(["next.ts"]);
    expect(failures).toEqual(["failed.ts"]);
    queue.enqueue("later.ts");
    await queue.settled();
    expect(snapshots.at(-1)).toEqual(["next.ts", "later.ts"]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { installedStream } from "./installedStream";

function pendingSource() {
  let pulls = 0;
  let returns = 0;
  let finish: ((result: IteratorResult<number>) => void) | undefined;
  let observed: AbortSignal | undefined;
  const open = (signal: AbortSignal): AsyncIterable<number> => {
    observed = signal;
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            pulls++;
            return new Promise<IteratorResult<number>>((resolve) => {
              finish = resolve;
              signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
                once: true,
              });
            });
          },
          async return() {
            returns++;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  };
  return {
    open,
    get pulls() {
      return pulls;
    },
    get returns() {
      return returns;
    },
    get signal() {
      return observed;
    },
    deliver: (value: number) => finish?.({ done: false, value }),
  };
}

describe("installed stream lifetime", () => {
  it("return interrupts a pending pull and releases once", async () => {
    const source = pendingSource();
    const iterator = installedStream(source.open, new AbortController().signal, () => {})[
      Symbol.asyncIterator
    ]();
    expect(source.pulls).toBe(0);
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toThrow("expired");
    await iterator.return?.();
    await rejected;
    expect(source.signal?.aborted).toBe(true);
    expect(source.returns).toBe(1);
    expect((await iterator.next()).done).toBe(true);
    await iterator.return?.();
    expect(source.returns).toBe(1);
  });
  it("revocation suppresses late data while another stream remains usable", async () => {
    const revoked = new AbortController();
    const source = pendingSource();
    const unaffected = pendingSource();
    const a = installedStream(source.open, revoked.signal, () => {})[Symbol.asyncIterator]();
    const b = installedStream(unaffected.open, new AbortController().signal, () => {})[
      Symbol.asyncIterator
    ]();
    const first = a.next();
    const rejected = expect(first).rejects.toThrow("expired");
    const second = b.next();
    revoked.abort();
    source.deliver(999);
    unaffected.deliver(42);
    await rejected;
    expect(await second).toEqual({ done: false, value: 42 });
    expect(unaffected.signal?.aborted).toBe(false);
    await b.return?.();
  });
  it("rejects concurrent pulls without reading ahead", async () => {
    const source = pendingSource();
    const iterator = installedStream(source.open, new AbortController().signal, () => {})[
      Symbol.asyncIterator
    ]();
    const pending = iterator.next();
    await expect(iterator.next()).rejects.toThrow("one extension stream pull");
    expect(source.pulls).toBe(1);
    source.deliver(1);
    expect(await pending).toEqual({ done: false, value: 1 });
    expect(source.pulls).toBe(1);
    await iterator.return?.();
  });
  it("checks current authority again after asynchronous delivery", async () => {
    const source = pendingSource();
    let allowed = true;
    const iterator = installedStream(source.open, new AbortController().signal, () => {
      if (!allowed) throw new Error("Permission removed");
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    allowed = false;
    source.deliver(1);
    await expect(pending).rejects.toThrow("Permission removed");
    expect(source.returns).toBe(1);
  });
});

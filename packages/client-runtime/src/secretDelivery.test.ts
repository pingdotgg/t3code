import { SecretDeliveryError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createSecretDeliveryReveal, secretDeliveryDisplay } from "./secretDelivery.ts";
import type { AtomCommandResult } from "./state/runtime.ts";

type ReadResult = AtomCommandResult<{ readonly value: string }, unknown>;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Each read waits for the test to settle it, so a test can act while it is in flight. */
function setup() {
  const reads: Array<ReturnType<typeof deferred<ReadResult>>> = [];
  const deletes: Array<ReturnType<typeof deferred<AtomCommandResult<void, unknown>>>> = [];
  const reveal = createSecretDeliveryReveal({
    read: () => {
      const read = deferred<ReadResult>();
      reads.push(read);
      return read.promise;
    },
    delete: () => {
      const removal = deferred<AtomCommandResult<void, unknown>>();
      deletes.push(removal);
      return removal.promise;
    },
  });
  const copies: Array<string> = [];
  const clipboard = (value: Promise<string>) =>
    value.then((text) => {
      copies.push(text);
      return true;
    });
  return { reveal, reads, deletes, copies, clipboard };
}

const secret = (value: string): ReadResult => AsyncResult.success({ value });

describe("secretDeliveryDisplay", () => {
  const local = { visibility: "local", deadlinePassed: false, canRetrieve: true } as const;

  it("expires on the client deadline before the server's status arrives", () => {
    expect(
      secretDeliveryDisplay({ secretStatus: "available" }, { ...local, deadlinePassed: true }),
    ).toMatchObject({ kind: "unavailable", reason: "expired" });
  });

  it("offers retrieval only in the original thread with operate access", () => {
    expect(secretDeliveryDisplay({ secretStatus: "available" }, local)).toEqual({
      kind: "available",
    });
    expect(
      secretDeliveryDisplay({ secretStatus: "available" }, { ...local, visibility: "inherited" }),
    ).toMatchObject({ reason: "elsewhere" });
    expect(
      secretDeliveryDisplay({ secretStatus: "available" }, { ...local, canRetrieve: false }),
    ).toMatchObject({ reason: "private" });
    expect(secretDeliveryDisplay({ secretStatus: "deleted" }, local)).toMatchObject({
      reason: "deleted",
    });
  });
});

describe("createSecretDeliveryReveal", () => {
  it("reveals repeatedly, and Hide clears the value", async () => {
    const { reveal, reads } = setup();
    const first = reveal.reveal();
    reads[0]!.resolve(secret("pa55\n"));
    await first;
    expect(reveal.getState().value).toBe("pa55\n");

    reveal.hide();
    expect(reveal.getState().value).toBeNull();

    const second = reveal.reveal();
    reads[1]!.resolve(secret("pa55\n"));
    await second;
    expect(reveal.getState().value).toBe("pa55\n");
  });

  it("drops a read that settles after Hide, navigation or backgrounding", async () => {
    const { reveal, reads } = setup();
    const pending = reveal.reveal();
    reveal.hide();
    reads[0]!.resolve(secret("late"));
    await pending;
    expect(reveal.getState()).toMatchObject({ value: null, pending: null });
  });

  it("never copies a value whose read settles after Hide", async () => {
    const { reveal, reads, copies, clipboard } = setup();
    const pending = reveal.copy(clipboard);
    reveal.hide();
    reads[0]!.resolve(secret("late"));
    await pending;
    expect(copies).toEqual([]);
    expect(reveal.getState()).toMatchObject({ copied: false, error: null });
  });

  it("copies without revealing the value", async () => {
    const { reveal, reads, copies, clipboard } = setup();
    const pending = reveal.copy(clipboard);
    reads[0]!.resolve(secret("pa55"));
    await pending;
    expect(copies).toEqual(["pa55"]);
    expect(reveal.getState()).toMatchObject({ value: null, copied: true });
  });

  it("clears the value on Delete and keeps the deletion when hidden meanwhile", async () => {
    const { reveal, reads, deletes } = setup();
    const shown = reveal.reveal();
    reads[0]!.resolve(secret("pa55"));
    await shown;

    const removal = reveal.delete();
    expect(reveal.getState().value).toBeNull();
    reveal.hide();
    deletes[0]!.resolve(AsyncResult.success(undefined));
    await removal;
    expect(reveal.getState()).toMatchObject({ deleted: true, pending: null });

    await reveal.reveal();
    expect(reads).toHaveLength(1);
  });

  it("shows server errors and hides transport failures that could echo the value", async () => {
    const { reveal, reads } = setup();
    const unavailable = reveal.reveal();
    reads[0]!.resolve(
      AsyncResult.failure(Cause.fail(new SecretDeliveryError({ reason: "unavailable" }))),
    );
    await unavailable;
    expect(reveal.getState().error).toBe("This secret delivery is unavailable.");

    const garbled = reveal.reveal();
    reads[1]!.resolve(AsyncResult.failure(Cause.fail(new Error('Expected string, got "pa55"'))));
    await garbled;
    expect(reveal.getState().error).toBe("Could not read the secret. Try again.");
  });
});

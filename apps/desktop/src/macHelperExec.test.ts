import { assert, describe, it } from "@effect/vitest";

import { keepOpenAcrossExec } from "./macHelperExec.ts";

const FIOCLEX = 0x20006601;
const FIONCLEX = 0x20006602;

describe("keepOpenAcrossExec", () => {
  it("refuses the exec when an open descriptor would close, and flags the kept ones again", () => {
    const calls: Array<[number, number]> = [];
    const ioctl = (fd: number, request: number) => {
      calls.push([fd, request]);
      return fd === 4 && request === FIONCLEX ? -1 : 0;
    };

    assert.throws(() => keepOpenAcrossExec([0, 3, 4, 5], ioctl), "descriptor 4");
    assert.deepEqual(calls, [
      [0, FIONCLEX],
      [3, FIONCLEX],
      [4, FIONCLEX],
      [0, FIOCLEX],
      [3, FIOCLEX],
    ]);
  });

  it("reports descriptors it could not flag again after a failed exec", () => {
    const restore = keepOpenAcrossExec([0, 3], (fd, request) =>
      fd === 3 && request === FIOCLEX ? -1 : 0,
    );
    assert.deepEqual(restore(), [3]);
  });
});

import { assert, describe, it } from "vite-plus/test";

import { findDonor } from "./paneMotion";

const column = (x: number, width: number) => ({ x, y: 0, width, height: 880 });

describe("findDonor", () => {
  it("takes only a neighbour across the gutter, never one with panes between", () => {
    const closed = column(872, 416);
    const far = { box: column(0, 442), other: column(0, 1288) };
    const beside = { box: column(450, 414), other: column(450, 838) };

    assert.isNull(findDonor(closed, [far]));
    assert.strictEqual(findDonor(closed, [far, beside])?.neighbour, beside);
  });
});

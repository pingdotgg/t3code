import { MATRIX_OS_CONNECT_URL } from "@t3tools/shared/matrixOsConnect";
import { describe, expect, it, vi } from "vite-plus/test";

import { openMatrixOsConnect } from "./openMatrixOsConnect";

describe("openMatrixOsConnect", () => {
  it("opens the fixed Matrix OS handoff in the external browser", async () => {
    const openExternal = vi.fn(async () => undefined);

    await openMatrixOsConnect({ openExternal });

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(MATRIX_OS_CONNECT_URL);
  });
});

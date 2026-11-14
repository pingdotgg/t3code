import * as NodeOS from "node:os";
import { assert, it } from "vite-plus/test";

import { handleStdioError } from "./stdioErrors.ts";

const errorWithCode = (code: string, errno?: number) =>
  Object.assign(new Error(code), { code, errno });
const EDQUOT_ERRNO = NodeOS.constants.errno.EDQUOT;

it.each(["EPIPE", "ENOSPC"])("ignores %s on console output", (code) => {
  assert.doesNotThrow(() => handleStdioError(errorWithCode(code)));
});

// Node reports EDQUOT as UNKNOWN because libuv has no name for it.
it.skipIf(EDQUOT_ERRNO === undefined)("ignores EDQUOT on console output", () => {
  assert.doesNotThrow(() => handleStdioError(errorWithCode("UNKNOWN", -(EDQUOT_ERRNO ?? 0))));
});

it("rethrows other console output errors", () => {
  assert.throws(() => handleStdioError(errorWithCode("EIO")), "EIO");
  assert.throws(() => handleStdioError(errorWithCode("UNKNOWN", -5)), "UNKNOWN");
});

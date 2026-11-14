import { assert, it } from "vite-plus/test";

import { handleStdioError } from "./stdioErrors.ts";

const errorWithCode = (code: string) => Object.assign(new Error(code), { code });

it.each(["EPIPE", "ENOSPC", "EDQUOT"])("ignores %s on console output", (code) => {
  assert.doesNotThrow(() => handleStdioError(errorWithCode(code)));
});

it("rethrows other console output errors", () => {
  const error = errorWithCode("EIO");
  assert.throws(() => handleStdioError(error), "EIO");
});

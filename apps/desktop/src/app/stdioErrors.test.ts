// @effect-diagnostics-next-line nodeBuiltinImport:off -- Subprocesses exercise Node's fatal stream errors.
import * as NodeChildProcess from "node:child_process";
import { assert, it } from "vite-plus/test";

it.each([
  ["EPIPE", 0],
  ["ENOSPC", 0],
  ["EDQUOT", 0],
  ["EIO", 1],
])("handles %s with exit status %i", (code, exitStatus) => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { handleStdioError } from ${JSON.stringify(new URL("./stdioErrors.ts", import.meta.url).href)};
        const stream = process.stdout;
        const other = process.stderr;
        stream.on("error", handleStdioError);
        stream._write = (_chunk, _encoding, callback) => {
          callback(Object.assign(new Error("diagnostic output unavailable"), { code: ${JSON.stringify(code)} }));
        };
        stream.once("error", () => other.write("application continued\\n"));
        stream.write("diagnostic record\\n");
      `,
    ],
    { encoding: "utf8" },
  );

  assert.isUndefined(result.error);
  assert.equal(result.status, exitStatus, result.stderr);
  if (exitStatus === 0) {
    assert.include(result.stdout + result.stderr, "application continued");
  } else {
    assert.include(result.stderr, "diagnostic output unavailable");
    assert.include(result.stderr, code);
    assert.notInclude(result.stdout + result.stderr, "application continued");
  }
});

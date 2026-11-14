import { expect, it } from "vite-plus/test";
import { patchNativeCli } from "./nativeHook.js";

it("wraps the native runner in a finally hook and patches only once", () => {
  const original =
    "\tconst exitCode = await run({\n\t\targs: rustCliArgs\n\t});\n\tprocess.exit(exitCode);";
  const patched = patchNativeCli(original);
  expect(patched).toContain("await startRunHook(command,");
  expect(patched).toContain("finally {\n\t\tawait finishRunHook?.();");
  expect(patched).toContain("process.exit(exitCode)");
  expect(patchNativeCli(patched)).toBe(patched);
});

it("rejects an unknown native entrypoint before changing it", () => {
  expect(() => patchNativeCli("changed upstream entrypoint")).toThrow(
    "Unsupported Vite+ entrypoint",
  );
});

it("leaves an unsupported CLI runnable when the machine preload is enabled", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-preload-"));
  try {
    const directory = path.join(root, "vite-plus/dist");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(directory, "bin.js"), 'console.log("unmodified CLI");');
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", new URL("./preload.mjs", import.meta.url).href, path.join(directory, "bin.js")],
      { env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(result.stdout.trim()).toBe("unmodified CLI");
    expect(result.stderr).toBe("");
    await fs.mkdir(path.join(root, "vite-plus/binding"));
    await fs.writeFile(path.join(root, "vite-plus/binding/index.js"), "export {};");
    await fs.writeFile(
      path.join(directory, "bin.js"),
      'const command="--version"; const rustCliArgs=[]; const run=async()=>0;\n\tconst exitCode = await run({\n\t\targs: rustCliArgs\n\t});\nconsole.log("compatible CLI");',
    );
    const compatible = await promisify(execFile)(
      process.execPath,
      ["--import", new URL("./preload.mjs", import.meta.url).href, path.join(directory, "bin.js")],
      { env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(compatible.stdout.trim()).toBe("compatible CLI");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("does not execute hook modules supplied by ancestor package manifests", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-ancestor-"));
  try {
    await fs.mkdir(path.join(root, "project"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ vitePlus: { runHook: "./malicious.mjs" } }),
    );
    await fs.writeFile(
      path.join(root, "malicious.mjs"),
      'throw new Error("ancestor module executed")',
    );
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { startRunHook } from ${JSON.stringify(new URL("./nativeRunHook.js", import.meta.url).href)}; await startRunHook("run", ${JSON.stringify(path.join(root, "project"))});`,
      ],
      { env: { ...process.env, HOME: root, NODE_OPTIONS: "" } },
    );
    expect(result.stderr).toBe("");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

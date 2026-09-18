import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "alchemy-test";

const cli = fileURLToPath(new URL("../../bin/cli.js", import.meta.url));

it("state unsafe nuke requires approval and clears every stack with --yes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "alchemy-state-nuke-"));
  const state = join(cwd, ".alchemy", "state");
  try {
    for (const stack of ["First", "Second"]) {
      for (const stage of ["dev", "prod"]) {
        const directory = join(state, stack, stage);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "output.json"), "{}");
      }
    }
    const run = (args: string[]) =>
      spawnSync("bun", [cli, ...args], {
        cwd,
        env: { ...process.env, ALCHEMY_HOME: join(cwd, "home") },
        encoding: "utf8",
        timeout: 10000,
      });
    const args = ["state", "unsafe", "nuke", "--backend", "local"];
    expect(run(args).status).toBe(1);
    expect(readdirSync(state).sort()).toEqual(["First", "Second"]);
    const cleared = run([...args, "--yes"]);
    expect(cleared.status).toBe(0);
    expect(cleared.stdout).toContain("• First\n• Second");
    expect(cleared.stdout).toContain("Cleared First");
    expect(cleared.stdout).toContain("Cleared Second");
    expect(readdirSync(state)).toEqual([]);
    const empty = run(args);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("Nothing to clear");
    expect(
      run(["state", "delete", "/", "--recursive", "--backend", "local"]).status,
    ).toBe(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

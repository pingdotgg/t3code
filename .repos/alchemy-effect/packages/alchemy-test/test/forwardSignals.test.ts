import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pollUntil } from "../src/DevCli.ts";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`forwards ${signal} to DevCli and waits for cleanup`, async () => {
    const root = mkdtempSync(join(tmpdir(), "alchemy-forward-signals-"));
    const devCli = resolve(import.meta.dirname, "../src/DevCli.ts");
    writeFileSync(
      join(root, "cli.ts"),
      `
      import { writeFileSync } from "node:fs";
      process.on(${JSON.stringify(signal)}, () => {
        setTimeout(() => { writeFileSync("cleaned", "yes"); process.exit(0); }, 200);
      });
      writeFileSync("child.pid", String(process.pid));
      setInterval(() => {}, 1000);
    `,
    );
    writeFileSync(
      join(root, "owner.test.ts"),
      `
      import { afterAll, test } from "bun:test";
      import { writeFileSync } from "node:fs";
      import { DevCli } from ${JSON.stringify(devCli)};
      const cli = new DevCli({ root: process.cwd(), alchemyBin: process.cwd() + "/cli.ts" });
      afterAll(async () => { writeFileSync("afterAll", "yes"); await cli.stop(); });
      test("running", async () => { cli.start(); await Bun.sleep(60000); }, 65000);
    `,
    );
    const runner = spawn(process.execPath, ["test", "owner.test.ts"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ALCHEMY_PROFILE: "alchemy" },
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      runner.once("exit", resolve);
      runner.once("error", reject);
    });
    const timeout = setTimeout(() => runner.kill("SIGKILL"), 6000);
    let childPid: number | undefined;
    try {
      await pollUntil(
        "CLI started",
        () => (existsSync(join(root, "child.pid")) ? true : undefined),
        { tries: 80, delayMs: 50 },
      );
      childPid = Number(readFileSync(join(root, "child.pid"), "utf8"));
      process.kill(-runner.pid!, signal);
      // A launcher can forward the same terminal signal more than once.
      await Bun.sleep(50);
      process.kill(-runner.pid!, signal);
      expect(await exited).toBe(signal === "SIGINT" ? 130 : 143);
      expect(existsSync(join(root, "cleaned"))).toBe(true);
      expect(existsSync(join(root, "afterAll"))).toBe(false);
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      clearTimeout(timeout);
      runner.kill("SIGKILL");
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
}

import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Manifest } from "../src/Manifest.ts";

const cli = resolve(import.meta.dir, "../src/cli/bin.ts");

test("CLI selects PR packages, honors overrides, and clears empty output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pkg-selection-"));
  const env = { ...process.env };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_OUTPUT;
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${args.join(" ")}: ${stdout}\n${stderr}`);
    return stdout.trim();
  };
  try {
    await run(["git", "init", "-q"]);
    await run(["git", "config", "user.email", "test@example.com"]);
    await run(["git", "config", "user.name", "Test"]);
    for (const name of ["core", "aws", "cloudflare"]) {
      const dir = join(cwd, "packages", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          dependencies: name === "core" ? {} : { core: "1.0.0" },
        }),
      );
      writeFileSync(join(dir, "index.js"), "export const value = 1;");
    }
    await run(["git", "add", "."]);
    await run(["git", "commit", "-qm", "base"]);
    const base = await run(["git", "rev-parse", "HEAD"]);
    writeFileSync(
      join(cwd, "packages/cloudflare/index.js"),
      "export const value = 2;",
    );
    await run(["git", "add", "."]);
    await run(["git", "commit", "-qm", "change"]);
    const head = await run(["git", "rev-parse", "HEAD"]);
    const pack = async (...flags: string[]) => {
      await run([
        process.execPath,
        cli,
        "pack",
        "--group",
        "SDK=./packages/*",
        ...flags,
      ]);
      const manifest: Manifest = JSON.parse(
        readFileSync(join(cwd, ".pkg/pkg-manifest.json"), "utf8"),
      );
      return manifest.packages.map((pkg) => pkg.name);
    };
    expect(await pack("--since", base)).toEqual(["cloudflare", "core"]);
    expect(await pack("--since", "HEAD")).toEqual([]);
    expect(existsSync(join(cwd, ".pkg/cloudflare.tgz"))).toBe(false);

    env.GITHUB_EVENT_NAME = "pull_request";
    env.GITHUB_EVENT_PATH = join(cwd, "event.json");
    env.GITHUB_OUTPUT = join(cwd, "output");
    const event = {
      pull_request: {
        base: { sha: base },
        head: { sha: head },
        labels: [] as { name: string }[],
      },
    };
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
    expect(await pack()).toEqual(["cloudflare", "core"]);
    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toContain(
      "package-count=2",
    );
    expect(await pack("--all")).toEqual(["aws", "cloudflare", "core"]);
    event.pull_request.labels.push({ name: "force-ci" });
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
    // Repository-specific labels have no meaning to the CLI.
    expect(await pack()).toEqual(["cloudflare", "core"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

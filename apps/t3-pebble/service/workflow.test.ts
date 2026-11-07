import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("installs a configured watch build and companion without exposing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-pebble-workflow-"));
  const app = join(dir, "app"), bin = join(dir, "bin"), home = join(dir, "home");
  await Promise.all([mkdir(join(app, "service"), { recursive: true }), mkdir(join(app, "src/pkjs"), { recursive: true }), mkdir(bin), mkdir(join(home, ".t3/userdata"), { recursive: true })]);
  for (const file of ["install.sh", "configure-build.ts", "package.template.json", "service-run.sh", "service/install.ts"]) await copyFile(file, join(app, file));
  await chmod(join(app, "install.sh"), 0o755);
  await writeFile(join(home, ".t3/userdata/server-runtime.json"), JSON.stringify({ origin: "http://127.0.0.1:1234" }));
  const stubs: Record<string, string> = {
    tailscale: `if [ "$1" = status ]; then printf '%s' '{"BackendState":"Running","Self":{"DNSName":"mac.example.","TailscaleIPs":["100.1.2.3"]}}'; fi\nexit 0`,
    pebble: 'printf "%s\\n" "$*" >> "$TEST_LOG"\nexit 0',
    openssl: 'printf test-private-token',
    lsof: 'exit 1',
    launchctl: '[ "$1" = print ] && exit 1\nexit 0',
  };
  for (const [name, body] of Object.entries(stubs)) { const path = join(bin, name); await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755); }
  try {
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: join(dir, "log") };
    delete env.T3CODE_HOME;
    const child = Bun.spawn([join(app, "install.sh"), "192.0.2.4"], { cwd: app, env, stdout: "pipe", stderr: "pipe" });
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(output).not.toContain("test-private-token");
    expect(await readFile(join(dir, "log"), "utf8")).toContain("install --phone 192.0.2.4");
    const config = JSON.parse(await readFile(join(app, "src/pkjs/config.json"), "utf8"));
    expect(config.url).toBe("https://mac.example:9383");
    expect(config.token).toBe("test-private-token");
    expect(await readFile(join(home, "Library/LaunchAgents/codes.t3.pebble-companion.plist"), "utf8")).toContain("100.1.2.3");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

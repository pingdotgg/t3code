import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("installs an isolated launch agent without overwriting an existing agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-pebble-install-"));
  const stub = join(dir, "launchctl");
  await writeFile(stub, "#!/bin/sh\n[ \"$1\" = print ] && exit 1\nexit 0\n");
  await chmod(stub, 0o755);
  const env = { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, T3_PEBBLE_INSTALL_DIR: "/tmp/example & app", T3_PEBBLE_INSTALL_STATE: "/tmp/state.json", T3_PEBBLE_INSTALL_DOMAIN: "watch.example", T3_PEBBLE_INSTALL_IP: "100.1.2.3" };
  try {
    const install = () => Bun.spawn([process.execPath, "service/install.ts"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await install().exited).toBe(0);
    const plist = await readFile(join(dir, "Library/LaunchAgents/codes.t3.pebble-companion.plist"), "utf8");
    expect(plist).toContain("/tmp/example &amp; app/service-run.sh");
    expect(plist).toContain("watch.example");
    expect(plist).not.toContain("ELEVENLABS_API_KEY");
    expect(await install().exited).not.toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

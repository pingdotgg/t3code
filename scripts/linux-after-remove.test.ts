// @effect-diagnostics nodeBuiltinImport:off - Runs the shipped deb postrm with stubbed system tools.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const template = NodePath.resolve(
  import.meta.dirname,
  "../apps/desktop/resources/linux/after-remove.tpl",
);

const stub = (log: string) => `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("deb after-remove", () => {
  it.each([
    ["upgrade", true],
    ["failed-upgrade", true],
    ["abort-upgrade", true],
    ["remove", false],
    ["purge", false],
  ])("postrm %s keeps the AppArmor profile: %s", async (action, keepsProfile) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-after-remove-"));
    try {
      const bin = NodePath.join(root, "bin");
      const apparmor = NodePath.join(root, "apparmor.d");
      const profile = NodePath.join(apparmor, "t3code");
      const alternativesLog = NodePath.join(root, "update-alternatives.log");
      await NodeFSP.mkdir(bin);
      await NodeFSP.mkdir(apparmor);
      await NodeFSP.writeFile(profile, "profile t3code {}\n");
      await NodeFSP.writeFile(NodePath.join(bin, "update-alternatives"), stub(alternativesLog), {
        mode: 0o755,
      });
      for (const tool of ["apparmor_parser", "apparmor_status"]) {
        await NodeFSP.writeFile(NodePath.join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      const script = NodePath.join(root, "postrm");
      const rendered = (await NodeFSP.readFile(template, "utf8"))
        .replaceAll("${executable}", "t3code")
        .replaceAll("${sanitizedProductName}", "T3 Code (Nightly)")
        .replaceAll("/etc/apparmor.d/", `${apparmor}/`);
      expect(rendered).not.toContain("/etc/");
      await NodeFSP.writeFile(script, rendered);

      const result = NodeChildProcess.spawnSync("bash", [script, action], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);

      const exists = (file: string) =>
        NodeFSP.access(file).then(
          () => true,
          () => false,
        );
      const lines = async (file: string) =>
        (await exists(file)) ? (await NodeFSP.readFile(file, "utf8")).split("\n").slice(0, -1) : [];
      expect(await exists(profile)).toBe(keepsProfile);
      expect(await lines(alternativesLog)).toEqual(
        keepsProfile ? [] : ["--remove", "t3code", "/opt/T3 Code (Nightly)/t3code"],
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

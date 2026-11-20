import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This build helper targets the actual host, outside an Effect runtime.
if (process.platform === "linux") {
  const root = new URL("../../../native/phone-passkeys/", import.meta.url);
  const targetDir = NodeURL.fileURLToPath(new URL("target", root));
  // The desktop app uses this helper whenever it exists, so a stale build must not outlive a failed one.
  const helper = NodeURL.fileURLToPath(new URL("target/debug/t3-phone-passkeys", root));
  const removeHelper = () => {
    try {
      NodeFS.rmSync(helper, { force: true });
    } catch (error) {
      console.warn(`[phone-passkeys] Could not remove the stale helper at ${helper}: ${error}`);
    }
  };
  const available = (command, args) =>
    NodeChildProcess.spawnSync(command, args, { stdio: "ignore" }).status === 0;
  if (!available("cargo", ["--version"]) || !available("pkg-config", ["--exists", "libudev"])) {
    removeHelper();
    console.warn(
      "[phone-passkeys] Skipping native helper: install Cargo and libudev development headers to enable phone passkeys in desktop development.",
    );
  } else {
    const result = NodeChildProcess.spawnSync(
      "cargo",
      [
        "build",
        "--locked",
        "--manifest-path",
        NodeURL.fileURLToPath(new URL("Cargo.toml", root)),
        "--target-dir",
        targetDir,
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      removeHelper();
      console.warn(
        "[phone-passkeys] Native helper build failed (it needs Rust 1.88 or newer and libudev headers); desktop development will continue without phone passkeys.",
      );
    }
  }
}

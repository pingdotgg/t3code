import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This build helper targets the actual host, outside an Effect runtime.
if (process.platform === "linux") {
  const manifest = NodeURL.fileURLToPath(
    new URL("../../../native/phone-passkeys/Cargo.toml", import.meta.url),
  );
  const available = (command, args) =>
    NodeChildProcess.spawnSync(command, args, { stdio: "ignore" }).status === 0;
  if (!available("cargo", ["--version"]) || !available("pkg-config", ["--exists", "libudev"])) {
    console.warn(
      "[phone-passkeys] Skipping native helper: install Cargo and libudev development headers to enable phone passkeys in desktop development.",
    );
  } else
    NodeChildProcess.execFileSync("cargo", ["build", "--locked", "--manifest-path", manifest], {
      stdio: "inherit",
    });
}

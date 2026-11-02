import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This build helper targets the actual host, outside an Effect runtime.
if (process.platform === "linux") {
  const manifest = NodeURL.fileURLToPath(
    new URL("../../../native/phone-passkeys/Cargo.toml", import.meta.url),
  );
  NodeChildProcess.execFileSync(
    "cargo",
    ["build", "--locked", "--release", "--manifest-path", manifest],
    { stdio: "inherit" },
  );
}

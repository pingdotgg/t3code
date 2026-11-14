import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { it } from "vite-plus/test";

// The converter is C++, so its test compiles and runs on the host.
it("transcodes UTF-16 the way jsi::String::utf8 does", () => {
  NodeChildProcess.execFileSync(
    "bash",
    [NodeURL.fileURLToPath(new URL("./run.sh", import.meta.url))],
    {
      stdio: "pipe",
    },
  );
});

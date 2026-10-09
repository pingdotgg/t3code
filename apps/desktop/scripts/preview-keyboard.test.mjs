import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
// Opt in because this regression needs a real Electron window and a desktop session.
describe.skipIf(process.env.T3CODE_TEST_ELECTRON !== "1")("desktop preview keyboard", () => {
  it("delivers input to visible and hidden guests while preserving the host draft", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-preview-keyboard-"));
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    try {
      const output = await new Promise((resolve, reject) => {
        NodeChildProcess.execFile(
          require("electron"),
          [
            NodeURL.fileURLToPath(new URL("./fixtures/preview-keyboard.cjs", import.meta.url)),
            directory,
          ],
          { env: environment, timeout: 30_000 },
          (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
            else resolve(stdout);
          },
        );
      });
      const result = JSON.parse(output.trim().split("\n").at(-1));
      expect(result.results).toEqual([
        "hidden input and keys",
        "visible input and keys",
        "textarea, contenteditable, and shadow input",
        "same-site frame",
        "cross-site frame",
        "editing shortcuts, canceled keys, and trusted events",
        "undeliverable text fails and the queue recovers",
        "Enter navigation preserves the host draft",
      ]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

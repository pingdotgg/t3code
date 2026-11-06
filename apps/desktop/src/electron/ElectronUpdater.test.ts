// @effect-diagnostics nodeBuiltinImport:off -- Exercises the isolated macOS updater shell script.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

import { MAC_BUNDLE_SWAP_SCRIPT } from "./ElectronUpdater.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ominax-updater-test-"));
  roots.push(root);
  const oldApp = NodePath.join(root, "T3 Learn.app");
  const source = NodePath.join(root, "source", "OminaX.app");
  const tools = NodePath.join(root, "tools");
  NodeFS.mkdirSync(oldApp, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(oldApp, "old"), "old");
  NodeFS.mkdirSync(source, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(source, "new"), "new");
  NodeFS.mkdirSync(tools);
  NodeFS.writeFileSync(
    NodePath.join(tools, "ditto"),
    '#!/bin/sh\nmkdir -p "$4/OminaX.app" && cp -R "$ZIP_SOURCE"/. "$4/OminaX.app"/\n',
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(NodePath.join(tools, "xattr"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  NodeFS.writeFileSync(
    NodePath.join(tools, "open"),
    '#!/bin/sh\nprintf \'%s\' "$1" > "$OPEN_LOG"\n',
    { mode: 0o755 },
  );
  return { root, oldApp, source, tools };
};

const run = (input: ReturnType<typeof fixture>, zipSource = input.source) => {
  const log = NodePath.join(input.root, "opened");
  const result = NodeChildProcess.spawnSync(
    "/bin/sh",
    [
      "-c",
      'sleep 0.05 & p=$!; /bin/sh -c "$OMINAX_SCRIPT" ominax-update "$p" update.zip "$OMINAX_APP"',
    ],
    {
      env: {
        ...process.env,
        PATH: `${input.tools}:${process.env.PATH}`,
        ZIP_SOURCE: zipSource,
        OPEN_LOG: log,
        OMINAX_SCRIPT: MAC_BUNDLE_SWAP_SCRIPT,
        OMINAX_APP: input.oldApp,
      },
    },
  );
  return { result, log };
};

it("installs a renamed bundle beside the old app before removing the old app", () => {
  const input = fixture();
  const { result, log } = run(input);
  expect(result.status).toBe(0);
  expect(NodeFS.existsSync(NodePath.join(input.root, "OminaX.app", "new"))).toBe(true);
  expect(NodeFS.existsSync(input.oldApp)).toBe(false);
  expect(NodeFS.readFileSync(log, "utf8")).toBe(NodePath.join(input.root, "OminaX.app"));
});

it("reopens the old app when extraction fails", () => {
  const input = fixture();
  const { log } = run(input, NodePath.join(input.root, "missing"));
  expect(NodeFS.existsSync(input.oldApp)).toBe(true);
  expect(NodeFS.existsSync(NodePath.join(input.root, "OminaX.app"))).toBe(false);
  expect(NodeFS.readFileSync(log, "utf8")).toBe(input.oldApp);
});

it("restores a stale renamed bundle when the new bundle swap aborts", () => {
  const input = fixture();
  const stale = NodePath.join(input.root, "OminaX.app");
  NodeFS.mkdirSync(stale, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(stale, "stale"), "stale");
  NodeFS.writeFileSync(
    NodePath.join(input.tools, "mv"),
    '#!/bin/sh\ncase "$1:$2" in *"/new/"*:*"OminaX.app"*) exit 1;; esac\nexec /bin/mv "$@"\n',
    { mode: 0o755 },
  );
  const { result } = run(input);
  expect(result.status).toBe(0);
  expect(NodeFS.existsSync(NodePath.join(stale, "stale"))).toBe(true);
  expect(NodeFS.existsSync(input.oldApp)).toBe(true);
});

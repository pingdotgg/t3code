import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const installerPath = NodeURL.fileURLToPath(
  new URL("./install-macos-update.sh", import.meta.url),
);

export function run(command, args, options = {}) {
  return NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    timeout: 7_000,
    ...options,
  });
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createBundle(base, version, options = {}) {
  NodeFS.mkdirSync(NodePath.join(base, "Contents/Resources/nested"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(base, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${options.id ?? "org.example.fixture"}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  NodeFS.writeFileSync(
    NodePath.join(base, "Contents/Resources/app.asar"),
    options.integration === false
      ? "fixture payload"
      : "fixture T3CODE_DESKTOP_UPDATE_INSTALLER payload",
  );
  NodeFS.writeFileSync(
    NodePath.join(base, "Contents/Resources/nested/content"),
    `payload:${version}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(base, ".version"), version);
  NodeFS.writeFileSync(NodePath.join(base, ".team"), options.team ?? "SYNTHETIC");
  if (options.signature !== false)
    NodeFS.writeFileSync(NodePath.join(base, ".signature-valid"), "synthetic");
  if (options.gatekeeper !== false)
    NodeFS.writeFileSync(NodePath.join(base, ".gatekeeper-valid"), "synthetic");
  NodeFS.writeFileSync(
    NodePath.join(base, "Contents/Resources/executable"),
    "#!/bin/sh\nexit 0\n",
    {
      mode: 0o755,
    },
  );
  NodeFS.symlinkSync("nested/content", NodePath.join(base, "Contents/Resources/content-link"));
}

export function snapshot(base, relative = "") {
  const entry = NodePath.join(base, relative);
  const stat = NodeFS.lstatSync(entry);
  const contents = stat.isSymbolicLink()
    ? NodeFS.readlinkSync(entry)
    : stat.isFile()
      ? NodeFS.readFileSync(entry).toString("base64")
      : "directory";
  const entries = [[relative, stat.mode & 0o777, contents]];
  if (stat.isDirectory()) {
    for (const name of NodeFS.readdirSync(entry).sort()) {
      entries.push(...snapshot(base, NodePath.join(relative, name)));
    }
  }
  return entries;
}

export function createFixture(options = {}) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "installer-fixture-"));
  const clean = () => NodeFS.rmSync(dir, { recursive: true, force: true });
  try {
    const bin = NodePath.join(dir, "fake-bin");
    NodeFS.mkdirSync(bin);
    const app = NodePath.join(dir, "Fixture App.app");
    createBundle(app, "1.0.0");
    const source = NodePath.join(dir, "release/Fixture App.app");
    createBundle(source, options.version ?? "2.0.0", options);
    const expected = snapshot(source);
    const archive = NodePath.join(dir, "selected.zip");
    const archived = run("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      source,
      archive,
    ]);
    NodeAssert.equal(archived.status, 0, archived.stderr);
    const events = NodePath.join(dir, "events");
    NodeFS.writeFileSync(events, "");

    // Only signature, Gatekeeper and launch boundaries are simulated; these are not signed-app fixtures.
    const stubs = {
      codesign: `#!/bin/sh
for arg do bundle=$arg; done
if [ "$1" = -dv ]; then printf 'TeamIdentifier=%s\\n' "$(cat "$bundle/.team")" >&2; exit 0; fi
printf 'verify:%s\\n' "$bundle" >> "$FIXTURE_EVENTS"
if [ "$bundle" = "$FIXTURE_APP" ] && [ "$(cat "$bundle/.version")" = 2.0.0 ]; then
  if kill -0 "$FIXTURE_PARENT" 2>/dev/null; then
    echo postverify-parent-alive >> "$FIXTURE_EVENTS"
  else
    echo postverify-parent-exited >> "$FIXTURE_EVENTS"
  fi
  if [ "\${FIXTURE_FAIL_INSTALLED:-0}" = 1 ]; then exit 31; fi
fi
[ -f "$bundle/.signature-valid" ] || exit 32
`,
      spctl: `#!/bin/sh
for arg do bundle=$arg; done
printf 'assess:%s\\n' "$bundle" >> "$FIXTURE_EVENTS"
[ -f "$bundle/.gatekeeper-valid" ] || exit 33
`,
      open: `#!/bin/sh
printf 'open:%s\\n' "$*" >> "$FIXTURE_EVENTS"
`,
    };
    for (const [name, contents] of Object.entries(stubs)) {
      NodeFS.writeFileSync(NodePath.join(bin, name), contents, { mode: 0o755 });
    }
    const original = NodeFS.readFileSync(
      new URL("./install-macos-update.sh", import.meta.url),
      "utf8",
    );
    const originalPath = "PATH=/usr/bin:/bin:/usr/sbin:/sbin";
    NodeAssert.equal(original.split(originalPath).length - 1, 1, "one fixed PATH assignment");
    const fixturePath = `PATH='${bin.replaceAll("'", "'\\''")}:/usr/bin:/bin:/usr/sbin:/sbin'`;
    const helper = NodePath.join(dir, "installer.sh");
    NodeFS.writeFileSync(helper, original.replace(originalPath, fixturePath), { mode: 0o755 });
    const env = {
      ...process.env,
      FIXTURE_APP: app,
      FIXTURE_EVENTS: events,
      FIXTURE_PARENT: "99999999",
    };
    const prepare = () => run("/bin/sh", [helper, "prepare", archive, app, "2.0.0"], { env });
    return { dir, app, archive, expected, helper, env, events, prepare, clean };
  } catch (error) {
    clean();
    throw error;
  }
}

export async function startParent() {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  await NodeEvents.once(child, "spawn");
  return child;
}

export async function stopParent(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = NodeEvents.once(child, "exit");
    child.stdin.end();
    await exited;
  }
}

export async function install(fixture, { relaunch = true, failInstalled = false } = {}) {
  const parent = await startParent();
  let child;
  let watchdog;
  let stdout = "";
  let stderr = "";
  try {
    const prepared = fixture.prepare();
    NodeAssert.equal(prepared.status, 0, prepared.stderr);
    const candidate = prepared.stdout.trim();
    const stage = NodePath.dirname(candidate);
    child = NodeChildProcess.spawn(
      "/bin/sh",
      [fixture.helper, "install", candidate, fixture.app, String(parent.pid), String(relaunch)],
      {
        env: {
          ...fixture.env,
          FIXTURE_PARENT: String(parent.pid),
          FIXTURE_FAIL_INSTALLED: failInstalled ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = NodeEvents.once(child, "close");
    watchdog = setTimeout(() => child.kill("SIGTERM"), 8_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("readiness absent while fixture parent lives")),
        3_000,
      );
      const onData = () => {
        if (stdout.includes("ready\n")) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (!stdout.includes("ready\n"))
          reject(new Error(`installer exited ${code} before ready: ${stderr}`));
      });
    });
    NodeAssert.equal(isAlive(parent.pid), true, "ready precedes fixture parent exit");
    NodeAssert.equal(NodeFS.readFileSync(NodePath.join(fixture.app, ".version"), "utf8"), "1.0.0");
    NodeAssert.equal(NodeFS.existsSync(candidate), true, "candidate remains staged at readiness");
    NodeAssert.equal(
      NodeFS.existsSync(`${fixture.app}.update-lock`),
      true,
      "ready follows lock acquisition",
    );
    NodeAssert.equal(NodeFS.readFileSync(fixture.events, "utf8").includes("open:"), false);
    await stopParent(parent);
    const [status] = await closed;
    return {
      status,
      stdout,
      stderr,
      stage,
      candidate,
      log: NodeFS.readFileSync(NodePath.join(stage, "install.log"), "utf8"),
      events: NodeFS.readFileSync(fixture.events, "utf8"),
    };
  } finally {
    clearTimeout(watchdog);
    await stopParent(parent);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = NodeEvents.once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  }
}

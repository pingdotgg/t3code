import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";
import {
  createFixture,
  install,
  installerPath,
  isAlive,
  run,
  snapshot,
  startParent,
  stopParent,
} from "./install-macos-update.fixtures.mjs";

describe.runIf(
  NodeFS.existsSync("/usr/libexec/PlistBuddy") && NodeFS.existsSync("/usr/bin/shlock"),
)("macOS update installer CLI", () => {
  it("rejects an unsigned app without altering it or leaving a staging directory", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "installer-unsigned-"));
    try {
      const app = NodePath.join(root, "Fixture App.app");
      NodeFS.mkdirSync(app);
      NodeFS.writeFileSync(NodePath.join(app, "sentinel"), "original");
      const result = run("/bin/sh", [installerPath, "prepare", "/missing.zip", app, "2.0.0"]);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.equal(NodeFS.readFileSync(NodePath.join(app, "sentinel"), "utf8"), "original");
      NodeAssert.deepEqual(NodeFS.readdirSync(root), ["Fixture App.app"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid parent arguments before signalling readiness", () => {
    for (const parent of ["0", "1", "-1", "oops"]) {
      const result = run("/bin/sh", [
        installerPath,
        "install",
        "/missing/candidate.app",
        "/missing/Fixture.app",
        parent,
        "true",
      ]);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.equal(result.stdout, "");
      NodeAssert.match(result.stderr, /Invalid parent PID/);
    }
  });

  it.each([
    ["publisher", { team: "OTHER" }, /publisher does not match/],
    ["identifier", { id: "org.example.other" }, /bundle identifier does not match/],
    ["version", { version: "3.0.0" }, /version does not match/],
    ["integration", { integration: false }, /lacks external installer support/],
    ["simulated Gatekeeper assessment", { gatekeeper: false }, null],
    ["simulated signature integrity", { signature: false }, null],
  ])("rejects an archive with invalid %s", (name, options, error) => {
    const fixture = createFixture(options);
    try {
      const result = fixture.prepare();
      NodeAssert.notEqual(result.status, 0, `${name} must reject selected archive`);
      if (error) NodeAssert.match(result.stderr, error);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.app, ".version"), "utf8"),
        "1.0.0",
      );
      NodeAssert.equal(
        NodeFS.readdirSync(fixture.dir).some((name) => name.startsWith(".t3-update.")),
        false,
      );
    } finally {
      fixture.clean();
    }
  });

  it("signals readiness before exit, swaps the intact bundle and requests relaunch", async () => {
    const fixture = createFixture();
    try {
      const result = await install(fixture);
      NodeAssert.equal(result.status, 0, result.log);
      NodeAssert.deepEqual(snapshot(fixture.app), fixture.expected);
      NodeAssert.equal(result.events.includes("postverify-parent-alive"), false);
      NodeAssert.equal(result.events.includes("postverify-parent-exited"), true);
      NodeAssert.match(result.events, /open:--env T3CODE_DESKTOP_UPDATE_INSTALLER=/);
      NodeAssert.match(result.events, /--env T3CODE_DISABLE_AUTO_UPDATE=false/);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(result.stage, "previous.app/.version"), "utf8"),
        "1.0.0",
      );
      NodeAssert.equal(NodeFS.existsSync(`${fixture.app}.update-lock`), false);
      NodeAssert.equal(NodeFS.existsSync(result.candidate), false);
    } finally {
      fixture.clean();
    }
  });

  it("restores the old bundle and requests relaunch after post-swap rejection", async () => {
    const fixture = createFixture();
    try {
      const original = snapshot(fixture.app);
      const result = await install(fixture, { failInstalled: true });
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.deepEqual(snapshot(fixture.app), original);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(result.stage, "failed.app/.version"), "utf8"),
        "2.0.0",
      );
      NodeAssert.match(result.events, /open:/);
      NodeAssert.equal(NodeFS.existsSync(`${fixture.app}.update-lock`), false);
    } finally {
      fixture.clean();
    }
  });

  it("rejects a busy real lock before signalling readiness or swapping", async () => {
    const fixture = createFixture();
    const parent = await startParent();
    try {
      const prepared = fixture.prepare();
      NodeAssert.equal(prepared.status, 0, prepared.stderr);
      const locked = run("/usr/bin/shlock", [
        "-p",
        String(process.pid),
        "-f",
        `${fixture.app}.update-lock`,
      ]);
      NodeAssert.equal(locked.status, 0, locked.stderr);
      const result = run(
        "/bin/sh",
        [
          fixture.helper,
          "install",
          prepared.stdout.trim(),
          fixture.app,
          String(parent.pid),
          "false",
        ],
        { env: fixture.env, timeout: 1_200 },
      );
      NodeAssert.equal(result.stdout, "");
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(result.stderr, /Another installation is running/);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.app, ".version"), "utf8"),
        "1.0.0",
      );
    } finally {
      await stopParent(parent);
      fixture.clean();
    }
  });

  it("recovers a stale real lock and respects relaunch=false", async () => {
    const fixture = createFixture();
    try {
      NodeAssert.equal(isAlive(99999999), false);
      NodeFS.writeFileSync(`${fixture.app}.update-lock`, "99999999\n");
      const result = await install(fixture, { relaunch: false });
      NodeAssert.equal(result.status, 0, result.log);
      NodeAssert.deepEqual(snapshot(fixture.app), fixture.expected);
      NodeAssert.equal(NodeFS.existsSync(`${fixture.app}.update-lock`), false);
      NodeAssert.equal(result.events.includes("open:"), false);
    } finally {
      fixture.clean();
    }
  });

  it("keeps one rollback backup while preserving unrelated paths", async () => {
    const fixture = createFixture();
    try {
      for (const name of [".t3-update.prior", ".t3-update.unrelated", ".t3-update.unmarked"]) {
        NodeFS.mkdirSync(NodePath.join(fixture.dir, name));
      }
      NodeFS.writeFileSync(
        NodePath.join(fixture.dir, ".t3-update.prior/installed-app"),
        `${fixture.app}\n`,
      );
      NodeFS.writeFileSync(
        NodePath.join(fixture.dir, ".t3-update.unrelated/installed-app"),
        `${NodePath.join(fixture.dir, "Other.app")}\n`,
      );
      NodeFS.writeFileSync(NodePath.join(fixture.dir, ".t3-update.unmarked/keep"), "untouched");
      NodeFS.symlinkSync(
        NodePath.join(fixture.dir, ".t3-update.unrelated"),
        NodePath.join(fixture.dir, ".t3-update.link"),
      );
      const result = await install(fixture);
      NodeAssert.equal(result.status, 0, result.log);
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(fixture.dir, ".t3-update.prior")), false);
      for (const name of [".t3-update.unrelated", ".t3-update.unmarked", ".t3-update.link"]) {
        NodeAssert.equal(
          NodeFS.existsSync(NodePath.join(fixture.dir, name)),
          true,
          `${name} preserved`,
        );
      }
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(result.stage, "previous.app")), true);
    } finally {
      fixture.clean();
    }
  });
});

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
      const result = run("/bin/sh", [
        installerPath,
        "/missing.zip",
        app,
        "2.0.0",
        "99999999",
        "false",
      ]);
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
        "/missing.zip",
        "/missing/Fixture.app",
        "2.0.0",
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
      const result = fixture.attempt();
      NodeAssert.equal(typeof result.status, "number", result.error?.message);
      NodeAssert.notEqual(result.status, 0, `${name} must reject selected archive`);
      NodeAssert.equal(result.stdout, "");
      if (error) NodeAssert.match(result.stderr, error);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.app, ".version"), "utf8"),
        "1.0.0",
      );
      for (const stage of NodeFS.readdirSync(fixture.dir).filter((name) =>
        name.startsWith(".t3-update."),
      )) {
        NodeAssert.equal(
          NodeFS.existsSync(NodePath.join(fixture.dir, stage, "candidate.app")),
          false,
        );
        NodeAssert.equal(NodeFS.existsSync(NodePath.join(fixture.dir, stage, "extracted")), false);
        NodeAssert.equal(NodeFS.existsSync(NodePath.join(fixture.dir, stage, "install.log")), true);
      }
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

  it.each([
    ["Fixture Beta.app", "Fixture Nightly.app"],
    ["Fixture Nightly.app", "Fixture Beta.app"],
    ["Renamed Fixture.app", "Fixture App.app"],
  ])("installs a different product basename: %s from %s", async (installedName, archiveName) => {
    const fixture = createFixture({ installedName, archiveName });
    try {
      const result = await install(fixture);
      NodeAssert.equal(result.status, 0, result.log);
      NodeAssert.deepEqual(snapshot(fixture.app), fixture.expected);
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
    try {
      const locked = run("/usr/bin/shlock", [
        "-p",
        String(process.pid),
        "-f",
        `${fixture.app}.update-lock`,
      ]);
      NodeAssert.equal(locked.status, 0, locked.stderr);
      const result = fixture.attempt();
      NodeAssert.equal(typeof result.status, "number", result.error?.message);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.equal(result.stdout, "");
      NodeAssert.match(result.stderr, /Another installation is running/);
      const stages = NodeFS.readdirSync(fixture.dir).filter((name) =>
        name.startsWith(".t3-update."),
      );
      NodeAssert.equal(stages.length, 1);
      NodeAssert.equal(
        NodeFS.existsSync(NodePath.join(fixture.dir, stages[0], "candidate.app")),
        false,
      );
      NodeAssert.equal(
        NodeFS.readFileSync(`${fixture.app}.update-lock`, "utf8").trim(),
        String(process.pid),
      );
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(fixture.app, ".version"), "utf8"),
        "1.0.0",
      );
    } finally {
      fixture.clean();
    }
  });

  it.each(["cancel", "timeout"])(
    "cleans its candidate after %s while preserving the live parent",
    async (failure) => {
      const fixture = createFixture();
      try {
        const original = snapshot(fixture.app);
        const unrelated = NodePath.join(fixture.dir, ".t3-update.unrelated");
        NodeFS.mkdirSync(unrelated);
        NodeFS.writeFileSync(NodePath.join(unrelated, "keep"), "untouched");
        const result = await install(fixture, { [failure]: true });
        NodeAssert.notEqual(result.status, 0);
        NodeAssert.deepEqual(snapshot(fixture.app), original);
        NodeAssert.equal(NodeFS.existsSync(result.candidate), false);
        NodeAssert.equal(NodeFS.existsSync(`${fixture.app}.update-lock`), false);
        NodeAssert.equal(NodeFS.existsSync(NodePath.join(result.stage, "install.log")), true);
        NodeAssert.equal(
          NodeFS.readFileSync(NodePath.join(unrelated, "keep"), "utf8"),
          "untouched",
        );
        NodeAssert.equal(result.events.includes("open:"), false);
        if (failure === "timeout") NodeAssert.match(result.log, /T3 did not exit/);
      } finally {
        fixture.clean();
      }
    },
  );

  it("rejects multiple matching bundles and accepts one match among unrelated bundles", async () => {
    const ambiguous = createFixture({ extraBundles: [{}] });
    const unique = createFixture({ extraBundles: [{ id: "org.example.unrelated" }] });
    try {
      const rejected = ambiguous.attempt();
      NodeAssert.equal(rejected.status, 1, rejected.stderr);
      NodeAssert.match(rejected.stderr, /Multiple update bundles/);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(ambiguous.app, ".version"), "utf8"),
        "1.0.0",
      );
      const accepted = await install(unique);
      NodeAssert.equal(accepted.status, 0, accepted.log);
      NodeAssert.deepEqual(snapshot(unique.app), unique.expected);
    } finally {
      ambiguous.clean();
      unique.clean();
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

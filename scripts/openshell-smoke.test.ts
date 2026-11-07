// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";

import { chooseTemplate, parseSmokeEnv, smokeSandboxName } from "./openshell-smoke.ts";

const scriptPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "openshell-smoke.ts",
);

describe("parseSmokeEnv", () => {
  it("skips cleanly when neither secret is configured", () => {
    const plan = parseSmokeEnv({});
    assert.strictEqual(plan.kind, "skip");
    assert.ok(plan.kind === "skip" && plan.reason.includes("OPENSHELL_SMOKE_GATEWAY_URL"));
    assert.ok(plan.kind === "skip" && plan.reason.includes("OPENSHELL_SMOKE_GATEWAY_CREDENTIAL"));
  });

  it("treats empty-string secrets as unset, as GitHub passes unset secrets", () => {
    const plan = parseSmokeEnv({
      OPENSHELL_SMOKE_GATEWAY_URL: "",
      OPENSHELL_SMOKE_GATEWAY_CREDENTIAL: "   ",
    });
    assert.strictEqual(plan.kind, "skip");
  });

  it("rejects exactly one secret being set", () => {
    const urlOnly = parseSmokeEnv({ OPENSHELL_SMOKE_GATEWAY_URL: "https://gateway.example.test" });
    assert.strictEqual(urlOnly.kind, "invalid");
    assert.ok(
      urlOnly.kind === "invalid" && urlOnly.message.includes("OPENSHELL_SMOKE_GATEWAY_CREDENTIAL"),
    );
    const credentialOnly = parseSmokeEnv({ OPENSHELL_SMOKE_GATEWAY_CREDENTIAL: "token" });
    assert.strictEqual(credentialOnly.kind, "invalid");
    assert.ok(
      credentialOnly.kind === "invalid" &&
        credentialOnly.message.includes("OPENSHELL_SMOKE_GATEWAY_URL"),
    );
  });

  it("runs with both secrets and applies the default timeout", () => {
    const plan = parseSmokeEnv({
      OPENSHELL_SMOKE_GATEWAY_URL: "https://gateway.example.test",
      OPENSHELL_SMOKE_GATEWAY_CREDENTIAL: "token",
    });
    assert.strictEqual(plan.kind, "run");
    assert.ok(plan.kind === "run" && plan.config.gatewayUrl === "https://gateway.example.test");
    assert.ok(plan.kind === "run" && plan.config.timeoutSecs === undefined);
  });

  it("rejects a non-positive or non-numeric timeout", () => {
    for (const timeoutSecs of ["0", "-5", "soon", "1.5"]) {
      const plan = parseSmokeEnv({
        OPENSHELL_SMOKE_GATEWAY_URL: "https://gateway.example.test",
        OPENSHELL_SMOKE_GATEWAY_CREDENTIAL: "token",
        OPENSHELL_SMOKE_TIMEOUT_SECS: timeoutSecs,
      });
      assert.strictEqual(plan.kind, "invalid", `expected ${timeoutSecs} to be rejected`);
      assert.ok(plan.kind === "invalid" && plan.message.includes("positive whole number"));
    }
  });
});

describe("smokeSandboxName", () => {
  it("is deterministic, prefixed, and hex-suffixed", () => {
    const name = smokeSandboxName("seed");
    assert.strictEqual(name, smokeSandboxName("seed"));
    assert.match(name, /^t3-smoke-[0-9a-f]{10}$/);
    assert.notStrictEqual(smokeSandboxName("other"), name);
  });
});

describe("chooseTemplate", () => {
  const templates = [
    { name: "desktop-managing", role: "managing" as const },
    { name: "t3-agent-worker", role: "worker" as const },
    { name: "bare-minimum" },
  ];

  it("prefers the explicit override and verifies it exists", () => {
    const choice = chooseTemplate(templates, "bare-minimum");
    assert.deepStrictEqual(choice, { ok: true, template: "bare-minimum" });
    const missing = chooseTemplate(templates, "nope");
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.ok === false && missing.message.includes("nope"));
    assert.ok(missing.ok === false && missing.message.includes("t3-agent-worker"));
  });

  it("falls back to a worker-labeled template, then the first listed", () => {
    const choice = chooseTemplate(templates);
    assert.deepStrictEqual(choice, { ok: true, template: "t3-agent-worker" });
    assert.deepStrictEqual(chooseTemplate([{ name: "only" }]), {
      ok: true,
      template: "only",
    });
  });

  it("demands a template when the gateway lists none", () => {
    const choice = chooseTemplate([]);
    assert.strictEqual(choice.ok, false);
    assert.ok(choice.ok === false && choice.message.includes("OPENSHELL_SMOKE_TEMPLATE"));
  });
});

describe("skip path (end-to-end)", () => {
  it("exits 0 with a SKIPPED line when run without secrets", () => {
    const output = NodeChildProcess.execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.ok(output.startsWith("SKIPPED:"));
    assert.ok(output.includes("repository secrets"));
  });

  it("exits non-zero with an INVALID line when only one secret is set", () => {
    let status = 0;
    let output = "";
    try {
      NodeChildProcess.execFileSync(process.execPath, [scriptPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          OPENSHELL_SMOKE_GATEWAY_URL: "https://gateway.example.test",
        },
      });
    } catch (error) {
      status = (error as { status: number }).status;
      output = `${(error as { stdout: Buffer }).stdout}${(error as { stderr: Buffer }).stderr}`;
    }
    assert.notStrictEqual(status, 0);
    assert.ok(output.includes("INVALID:"));
  });
});

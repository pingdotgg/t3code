import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { describeValidationFailure, findTerminatingSignal } from "./AntigravityInstallation.ts";

describe("findTerminatingSignal", () => {
  it("extracts the signal name from a child-process interrupt error", () => {
    const cause = new Error("Process interrupted due to receipt of signal: 'SIGILL'");
    NodeAssert.equal(findTerminatingSignal(cause), "SIGILL");
  });

  it("walks a chain of wrapped causes to find the signal", () => {
    const signalError = new Error("Process interrupted due to receipt of signal: 'SIGILL'");
    const platformError = new Error("Unknown: ChildProcess.exitCode (agy_acp_server.par)", {
      cause: signalError,
    });
    const transportError = new Error("ACP transport operation read-process-exit-status failed.", {
      cause: platformError,
    });
    NodeAssert.equal(findTerminatingSignal(transportError), "SIGILL");
  });

  it("returns undefined when no signal is present in the chain", () => {
    const cause = new Error("The archive could not be read.", {
      cause: new Error("ENOENT: no such file or directory"),
    });
    NodeAssert.equal(findTerminatingSignal(cause), undefined);
  });

  it("returns undefined for non-error causes", () => {
    NodeAssert.equal(findTerminatingSignal(undefined), undefined);
    NodeAssert.equal(findTerminatingSignal("SIGILL"), undefined);
  });

  it("does not recurse forever on a cyclical cause chain", () => {
    const cause: Error & { cause?: unknown } = new Error("boom");
    cause.cause = cause;
    NodeAssert.equal(findTerminatingSignal(cause), undefined);
  });
});

describe("describeValidationFailure", () => {
  it("names AVX/AVX2 as the likely cause when the runtime is killed by SIGILL", () => {
    const cause = new Error("ACP transport operation read-process-exit-status failed.", {
      cause: new Error("Process interrupted due to receipt of signal: 'SIGILL'"),
    });
    const detail = describeValidationFailure(cause);
    NodeAssert.match(detail, /SIGILL/);
    NodeAssert.match(detail, /AVX/);
  });

  it("falls back to the generic message for other failures", () => {
    const cause = new Error("The downloaded runtime did not identify as the expected release.");
    NodeAssert.equal(
      describeValidationFailure(cause),
      "The downloaded Antigravity runtime could not start in this environment.",
    );
  });
});

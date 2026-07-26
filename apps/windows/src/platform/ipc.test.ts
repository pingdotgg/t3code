import { describe, expect, it } from "vite-plus/test";

import { type SidecarState, phaseForSidecarState, phaseLabel } from "./ipc.ts";

describe("phaseForSidecarState", () => {
  // Mirrors `LiveBackend.handleSidecarState` on macOS.
  it("reads the first launch as launching and later ones as reconnecting", () => {
    expect(phaseForSidecarState({ kind: "launching", restartAttempt: 0 })).toEqual({
      kind: "launchingServer",
    });
    expect(phaseForSidecarState({ kind: "launching", restartAttempt: 3 })).toEqual({
      kind: "reconnecting",
      attempt: 3,
    });
  });

  it("treats a ready sidecar as connecting until the socket session is up", () => {
    // The server being up is not the same as the app being usable: auth,
    // getConfig and the subscriptions still have to land.
    expect(phaseForSidecarState({ kind: "ready", pid: 42 })).toEqual({ kind: "connecting" });
  });

  it("never surfaces a crash as terminal, because the supervisor restarts it", () => {
    const phase = phaseForSidecarState({
      kind: "crashed",
      reason: "exited with code 1",
      restartAttempt: 0,
    });
    // Attempt + 1: the crash we just saw was attempt 0, the next try is 1.
    expect(phase).toEqual({ kind: "reconnecting", attempt: 1 });
  });

  it("maps a deliberate stop back to idle rather than an error", () => {
    expect(phaseForSidecarState({ kind: "stopped" })).toEqual({ kind: "idle" });
    expect(phaseForSidecarState({ kind: "idle" })).toEqual({ kind: "idle" });
  });

  it("covers every state the Rust enum can serialize", () => {
    const states: SidecarState[] = [
      { kind: "idle" },
      { kind: "launching", restartAttempt: 0 },
      { kind: "ready", pid: 1 },
      { kind: "crashed", reason: "boom", restartAttempt: 2 },
      { kind: "stopped" },
    ];
    for (const state of states) {
      expect(phaseLabel(phaseForSidecarState(state))).toBeTypeOf("string");
    }
  });
});

describe("phaseLabel", () => {
  it("hides the attempt counter on the first retry and shows it after", () => {
    expect(phaseLabel({ kind: "reconnecting", attempt: 1 })).toBe("Reconnecting…");
    expect(phaseLabel({ kind: "reconnecting", attempt: 4 })).toBe("Reconnecting… (4)");
  });

  it("uses the macOS wording for the launch phase", () => {
    expect(phaseLabel({ kind: "launchingServer" })).toBe("Launching Server…");
    expect(phaseLabel({ kind: "ready" })).toBe("Connected");
  });

  it("passes a failure detail through verbatim", () => {
    expect(phaseLabel({ kind: "failed", detail: "Could not locate Node.js" })).toBe(
      "Could not locate Node.js",
    );
  });
});

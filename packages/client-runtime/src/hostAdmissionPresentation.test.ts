import { describe, expect, it } from "vite-plus/test";

import { hostAdmissionHoldReason, hostAdmissionWaitReason } from "./hostAdmissionPresentation.ts";

describe("hostAdmissionPresentation", () => {
  const admission = {
    runningTurns: 4,
    maxRunningTurns: 4,
    waitingTurns: 1,
    pacing: null,
    waitingThreadIds: [],
  };
  const severe = { ...admission, maxRunningTurns: null, pacing: "severe" as const };
  const paced = { ...admission, maxRunningTurns: null, pacing: "paced" as const };

  it("names the counts for a capacity wait only when the host reports a limit", () => {
    expect(hostAdmissionWaitReason("capacity", admission)).toContain("4/4");
    expect(hostAdmissionWaitReason("capacity", undefined)).not.toContain("/");
    expect(hostAdmissionWaitReason(undefined, admission)).toBeNull();
  });

  it("tells a severe hold from pacing", () => {
    expect(hostAdmissionWaitReason("host_load", severe)).not.toBe(
      hostAdmissionWaitReason("host_load", paced),
    );
  });

  it("explains a host-wide hold by the cap first, then by pacing", () => {
    expect(hostAdmissionHoldReason({ ...admission, pacing: "paced" })).toBe(
      hostAdmissionWaitReason("capacity", admission),
    );
    expect(hostAdmissionHoldReason(severe)).toBe(hostAdmissionWaitReason("host_load", severe));
    expect(hostAdmissionHoldReason({ ...admission, runningTurns: 2 })).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  finishedBeforeMuteEnd,
  isMutedCompletion,
  isThreadMuted,
  threadMuteEndsAt,
} from "./threadMute.ts";

const at = (time: string) => Date.parse(`2026-11-16T${time}:00.000Z`);
const iso = (time: string) => `2026-11-16T${time}:00.000Z`;

describe("thread mute", () => {
  it.each([
    { name: "never muted", mute: {}, now: "10:00", muted: false, endsAt: undefined },
    {
      name: "until unmuted",
      mute: { mutedAt: iso("09:00") },
      now: "23:00",
      muted: true,
      endsAt: null,
    },
    {
      name: "a timed mute in effect",
      mute: { mutedAt: iso("09:00"), mutedUntil: iso("09:15") },
      now: "09:14",
      muted: true,
      endsAt: at("09:15"),
    },
    {
      name: "a timed mute past its end, with no event",
      mute: { mutedAt: iso("09:00"), mutedUntil: iso("09:15") },
      now: "09:15",
      muted: false,
      endsAt: undefined,
    },
  ])("$name", ({ mute, now, muted, endsAt }) => {
    expect(isThreadMuted(mute, at(now))).toBe(muted);
    expect(threadMuteEndsAt(mute, at(now))).toBe(endsAt);
  });

  it("hides only runs that finished inside the mute", () => {
    const ended = { mutedAt: iso("09:00"), mutedUntil: iso("09:15") };
    expect(isMutedCompletion(ended, iso("09:10"))).toBe(true);
    expect(isMutedCompletion(ended, iso("09:16"))).toBe(false);
    // A run that finished before the mute began keeps its Done marker.
    expect(isMutedCompletion(ended, iso("08:59"))).toBe(false);
    expect(isMutedCompletion({ mutedAt: iso("09:00") }, iso("12:00"))).toBe(true);
    expect(isMutedCompletion({}, iso("09:10"))).toBe(false);
    expect(isMutedCompletion(ended, null)).toBe(false);
  });

  it("never replays an alert for a run that finished before the mute ended", () => {
    const ended = { mutedAt: iso("09:00"), mutedUntil: iso("09:15") };
    expect(finishedBeforeMuteEnd(ended, iso("08:59"))).toBe(true);
    expect(finishedBeforeMuteEnd(ended, iso("09:10"))).toBe(true);
    expect(finishedBeforeMuteEnd(ended, iso("09:16"))).toBe(false);
    expect(finishedBeforeMuteEnd({}, iso("09:10"))).toBe(false);
  });
});

import type { DesktopPreviewOwnership } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ownedPreviewSessions } from "./previewOwnership";

const sessions = [{ sessionKey: "unclaimed" }, { sessionKey: "here" }, { sessionKey: "elsewhere" }];

const ownership = (isHost: boolean): DesktopPreviewOwnership => ({
  version: 1,
  isHost,
  claimedHere: ["here"],
  claimedElsewhere: ["elsewhere"],
});

describe("ownedPreviewSessions", () => {
  it.each([
    { name: "nothing before the desktop answers", view: null, owned: [] },
    {
      name: "claims and unclaimed sessions in the host",
      view: ownership(true),
      owned: ["unclaimed", "here"],
    },
    { name: "only claims in another window", view: ownership(false), owned: ["here"] },
  ])("renders $name", ({ view, owned }) => {
    expect(ownedPreviewSessions(sessions, view).map((session) => session.sessionKey)).toEqual(
      owned,
    );
  });
});

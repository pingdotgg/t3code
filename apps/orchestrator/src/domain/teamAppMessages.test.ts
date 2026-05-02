import { describe, expect, it } from "vitest";

import {
  applyTeamAppMuteCommand,
  isAsideTeamAppMessage,
  shouldIgnoreTeamAppMessage,
} from "./teamAppMessages.ts";

describe("team app message domain helpers", () => {
  describe("isAsideTeamAppMessage", () => {
    it.each(["- aside this is for humans", " - aside: ignore this", "- ASIDE\nnot for ai"])(
      "detects aside prefix in %s",
      (body) => {
        expect(isAsideTeamAppMessage(body)).toBe(true);
      },
    );

    it.each(["aside but no dash", "-aside missing separator", "we should set aside time"])(
      "does not treat %s as an aside",
      (body) => {
        expect(isAsideTeamAppMessage(body)).toBe(false);
      },
    );
  });

  describe("shouldIgnoreTeamAppMessage", () => {
    it("hard-ignores aside messages even when the AI Engineer is mentioned", () => {
      expect(
        shouldIgnoreTeamAppMessage({
          body: "- aside @Engineering we should discuss privately",
          isThreadMuted: false,
          mentionsAiEngineer: true,
        }),
      ).toEqual({ ignore: true, reason: "aside" });
    });

    it("ignores ambient messages in muted Team App threads", () => {
      expect(
        shouldIgnoreTeamAppMessage({
          body: "I think we should revisit the UX copy",
          isThreadMuted: true,
        }),
      ).toEqual({ ignore: true, reason: "muted" });
    });

    it("allows mentions in muted Team App threads", () => {
      expect(
        shouldIgnoreTeamAppMessage({
          body: "@Engineering can you answer this?",
          isThreadMuted: true,
          mentionsAiEngineer: true,
        }),
      ).toEqual({ ignore: false });
    });

    it("allows unmute requests in muted Team App threads without requiring a mention", () => {
      expect(
        shouldIgnoreTeamAppMessage({
          body: "unmute please",
          isThreadMuted: true,
        }),
      ).toEqual({ ignore: false });
    });

    it("allows ordinary messages in unmuted Team App threads", () => {
      expect(
        shouldIgnoreTeamAppMessage({
          body: "Please keep going",
          isThreadMuted: false,
        }),
      ).toEqual({ ignore: false });
    });
  });

  describe("applyTeamAppMuteCommand", () => {
    it("mutes a Team App thread when requested", () => {
      expect(
        applyTeamAppMuteCommand({
          body: "@Engineering mute this thread",
          isThreadMuted: false,
        }),
      ).toEqual({ muted: true, changed: true, command: "mute" });
    });

    it("unmutes a Team App thread when requested", () => {
      expect(
        applyTeamAppMuteCommand({
          body: "unmute, you can respond again",
          isThreadMuted: true,
        }),
      ).toEqual({ muted: false, changed: true, command: "unmute" });
    });

    it("is idempotent for repeated mute and unmute requests", () => {
      expect(
        applyTeamAppMuteCommand({
          body: "mute please",
          isThreadMuted: true,
        }),
      ).toEqual({ muted: true, changed: false, command: "mute" });

      expect(
        applyTeamAppMuteCommand({
          body: "unmute please",
          isThreadMuted: false,
        }),
      ).toEqual({ muted: false, changed: false, command: "unmute" });
    });

    it("leaves mute state unchanged when there is no command", () => {
      expect(
        applyTeamAppMuteCommand({
          body: "Can you check the failing typecheck?",
          isThreadMuted: false,
        }),
      ).toEqual({ muted: false, changed: false });
    });
  });
});

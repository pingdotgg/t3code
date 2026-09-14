import { expect, it } from "vite-plus/test";

import { resolveSpeechPresentation, shouldShowComposerFooter } from "./ComposerSpeechButton";

it.each(["preparing", "recording", "transcribing", "error"] as const)(
  "keeps voice controls visible in a collapsed composer during %s",
  (phase) => {
    expect(shouldShowComposerFooter(true, false, phase)).toBe(true);
  },
);
it("keeps the idle collapsed footer hidden", () => {
  expect(shouldShowComposerFooter(true, false, "idle")).toBe(false);
});

it("maps voice input phases to composer actions", () => {
  expect(
    resolveSpeechPresentation({ phase: "idle", error: null, errorAction: null }, null),
  ).toMatchObject({ status: null, showsConfirm: false, showsSend: true });
  expect(
    resolveSpeechPresentation({ phase: "preparing", error: null, errorAction: null }, null),
  ).toMatchObject({
    status: "Preparing",
    showsCancel: true,
    confirmEnabled: false,
    showsSend: false,
  });
  expect(
    resolveSpeechPresentation({ phase: "recording", error: null, errorAction: null }, null),
  ).toMatchObject({
    status: "Recording",
    showsCancel: true,
    confirmEnabled: true,
    showsSend: false,
  });
  expect(
    resolveSpeechPresentation({ phase: "transcribing", error: null, errorAction: null }, null),
  ).toMatchObject({
    status: "Transcribing",
    showsCancel: true,
    confirmEnabled: false,
    showsSend: false,
  });
  expect(
    resolveSpeechPresentation(
      { phase: "error", error: "No speech was detected.", errorAction: "retry" },
      null,
    ),
  ).toMatchObject({ status: "No speech was detected.", showsConfirm: false, showsSend: true });
});

it("shows model download progress while preparing", () => {
  expect(
    resolveSpeechPresentation(
      { phase: "preparing", error: null, errorAction: null },
      { downloaded: 24, total: 48 },
    ).status,
  ).toBe("Downloading speech model 50%");
});

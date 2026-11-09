import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { chooseAudioDestination, chooseTranscriptCleanup } from "~/speech/voiceConsent";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it.each([
  ["transcription", "navigation"],
  ["cleanup", "navigation"],
  ["transcription", "queued-different"],
  ["transcription", "queued-equal"],
  ["transcription", "upload"],
  ["transcription", "attachment-change"],
  ["transcription", "prompt-change"],
])("keeps a confirmed voice submission owned by its draft: %s / %s", async (stage, scenario) => {
  const normal = threadWithHistory("dictation-a", 1);
  const b = threadWithHistory("dictation-b", 1);
  const template = threadWithHistory("dictation-queued", 1);
  const queued = {
    ...template,
    runs: template.runs.map((run) => ({
      ...run,
      status: "queued" as const,
      startedAt: null,
      completedAt: null,
    })),
  };
  const editing = scenario.startsWith("queued-");
  const a = editing ? queued : normal;
  using _environment = installFakeEnvironment([normal, b, queued], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  chooseAudioDestination({ kind: "environment", environmentId: ENVIRONMENT_ID });
  chooseTranscriptCleanup(stage === "cleanup");
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  const mainPrompt = scenario === "queued-equal" ? "Queued message" : "Fix";
  useComposerDraftStore.getState().setPrompt(aRef, mainPrompt);
  const file = {
    type: "file" as const,
    id: `dictation-file-${scenario}`,
    name: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    file: null,
    uploadedAttachmentId: `uploaded-${scenario}`,
    uploadEnvironmentId: ENVIRONMENT_ID,
  };
  const fileScenario = ["upload", "attachment-change", "prompt-change"].includes(scenario);
  if (fileScenario) useComposerDraftStore.getState().addFiles(aRef, [file]);
  useComposerDraftStore.getState().setPrompt(bRef, "Do not send");
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  await using _response = {
    [Symbol.asyncDispose]: () =>
      act(async () => {
        resolveResponse(Response.json({ text: "the login bug" }));
      }),
  };
  const fetch = globalThis.fetch;
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/voice/status")
      return Response.json({
        supported: true,
        state: "ready",
        modelId: "test-model",
        model: "Test",
        size: 1,
        supportsStreaming: false,
        supportsTranslation: false,
        acceleration: "auto",
        modelUnloadTimeout: "min_15",
        gpuDevices: [],
      });
    if (url.pathname === "/api/voice/transcribe")
      return stage === "transcription" ? response : Response.json({ text: "the login bug" });
    if (url.pathname === "/api/voice/post-process") return response;
    return fetch(input, init);
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot supplies its own router.
    router: false,
  });
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  using _audio = {
    [Symbol.dispose]: () => {
      oscillator.stop();
      void audio.close();
    },
  };
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(destination.stream);
  if (editing) {
    await page.getByRole("button", { name: "Edit queued message", exact: true }).click();
    await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("Queued message");
  }
  await page.getByRole("button", { name: "Start voice input", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Cancel voice input", exact: true }))
    .toBeVisible();
  await page
    .getByRole("button", {
      name: editing ? "Update queued message" : "Submit message",
      exact: true,
    })
    .click();
  await vi.waitFor(() =>
    expect(
      _fetch.mock.calls.some(([input]) =>
        String(input instanceof Request ? input.url : input).includes(
          stage === "transcription" ? "/api/voice/transcribe" : "/api/voice/post-process",
        ),
      ),
    ).toBe(true),
  );
  if (!editing) {
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
      }),
    );
    await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("Do not send");
  }
  if (fileScenario) {
    const before = useComposerDraftStore.getState().getComposerDraft(aRef);
    await act(() => {
      if (scenario === "attachment-change") {
        useComposerDraftStore.getState().removeFile(aRef, file.id);
        useComposerDraftStore
          .getState()
          .addFiles(aRef, [{ ...file, id: `${file.id}-replacement` }]);
      } else if (scenario === "prompt-change")
        useComposerDraftStore.getState().setPrompt(aRef, "Later text");
      else
        useComposerDraftStore
          .getState()
          .setFileUpload(aRef, file.id, ENVIRONMENT_ID, "completed-upload");
    });
    expect(useComposerDraftStore.getState().getComposerDraft(aRef)).not.toBe(before);
  }
  resolveResponse(Response.json({ text: "the login bug" }));
  if (scenario === "attachment-change" || scenario === "prompt-change") {
    await expect
      .element(page.getByText("Voice message was not sent", { exact: true }))
      .toBeVisible();
    expect(dispatchedCommands().filter((command) => command.type === "message.dispatch")).toEqual(
      [],
    );
    expect(useComposerDraftStore.getState().getComposerDraft(aRef)?.prompt).toBe(
      scenario === "prompt-change" ? "Later text" : "Fix",
    );
  } else if (editing) {
    await vi.waitFor(() =>
      expect(dispatchedCommands().filter((command) => command.type === "queued-run.edit")).toEqual([
        expect.objectContaining({ threadId: a.id, text: "Queued message the login bug" }),
      ]),
    );
    expect(dispatchedCommands().filter((command) => command.type === "message.dispatch")).toEqual(
      [],
    );
    expect(useComposerDraftStore.getState().getComposerDraft(aRef)?.prompt).toBe(mainPrompt);
  } else {
    await vi.waitFor(() =>
      expect(dispatchedCommands().filter((command) => command.type === "message.dispatch")).toEqual(
        [expect.objectContaining({ threadId: a.id, text: "Fix the login bug" })],
      ),
    );
  }
  expect(useComposerDraftStore.getState().getComposerDraft(bRef)?.prompt).toBe("Do not send");
  if (!editing)
    await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("Do not send");
});

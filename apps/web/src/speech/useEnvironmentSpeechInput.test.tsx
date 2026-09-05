import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

const mocks = vi.hoisted(() => ({ prepared: {} as PreparedConnection }));
vi.mock("../state/session", () => ({ usePreparedConnection: () => Option.some(mocks.prepared) }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => "" }));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));
vi.mock("../localApi", () => ({ ensureLocalApi: () => ({}) }));
vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () =>
    Effect.succeed({ supported: true, state: "ready", model: "test" }),
}));
vi.mock("./browserVoiceInput", () => ({
  createBrowserVoiceInputPlatform: () => ({
    recorder: {
      uri: null,
      prepareToRecordAsync: async () => {
        throw new Error("no microphone");
      },
      record() {},
      stop: async () => {},
    },
    transcriber: { prepare: async () => ({ locale: "en", transcribe: async () => "" }) },
    cancelRecording() {},
    deleteRecording() {},
  }),
}));

let root: Root | undefined;
let voice: ReturnType<typeof useEnvironmentSpeechInput>;
function Probe() {
  const value = useEnvironmentSpeechInput({
    environmentId: "environment" as EnvironmentId,
    ownerKey: "draft",
    draftText: "",
    readDraft: () => ({ text: "", selection: { start: 0, end: 0 } }),
    commitDraft() {},
  });
  useLayoutEffect(() => {
    voice = value;
  });
  return null;
}
afterEach(async () => {
  await act(() => root?.unmount());
  vi.unstubAllGlobals();
});
it("clears the previous connection's recording error when replacing the controller", async () => {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia() {} } });
  vi.stubGlobal("MediaRecorder", function MediaRecorder() {});
  root = createRoot(container as unknown as HTMLElement);
  await act(() => root!.render(<Probe />));
  await act(() => voice.start());
  expect(voice.state.phase).toBe("error");
  const previousConnection = mocks.prepared;
  mocks.prepared = {} as PreparedConnection;
  await act(() => root!.render(<Probe />));
  expect(voice.state).toEqual({ phase: "idle", error: null, errorAction: null });
  mocks.prepared = previousConnection;
  await act(() => root!.render(<Probe />));
  expect(voice.state).toEqual({ phase: "idle", error: null, errorAction: null });
});

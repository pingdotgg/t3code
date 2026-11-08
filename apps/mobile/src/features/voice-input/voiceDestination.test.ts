import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  chooseVoiceDestination,
  chooseTranscriptCleanup,
  pendingCloudVoiceChoice,
  voiceGrantAtom,
  voiceRouteAtom,
  voiceCleanupGrantAtom,
} from "./voiceDestination";
import { readVoiceGrant } from "./voiceGrantStorage";
import { readVoiceCleanupGrant } from "./voiceCleanupStorage";
import { useGlobalVoiceInput, localVoiceTranscriberAtom } from "./VoiceInputProvider";
import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";
import type { VoiceInputTarget } from "./voiceInputSession";

const mocks = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string | null>>(async () => null),
  write: vi.fn(),
  markerRead: vi.fn<() => string>(),
  markerWrite: vi.fn<(id: string) => void>(),
  probe: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  alert: vi.fn(),
}));
// Drive the production provider atom without mounting a native React tree.
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => appAtomRegistry.get(atom),
}));
vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("react-native-reanimated", () => ({
  makeMutable: (value: unknown) => ({ value, set() {} }),
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: () => {},
}));
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: { ios: {}, android: {} } },
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: async () => {},
  setIsAudioActiveAsync: async () => {},
  AudioModule: {
    AudioRecorder: class {
      uri = "file:///voice.m4a";
      async prepareToRecordAsync() {}
      record() {}
      async stop() {}
      getStatus() {
        return { isRecording: false };
      }
      addListener() {
        return { remove() {} };
      }
      getAvailableInputs() {
        return [];
      }
      release() {}
    },
  },
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: Atom.make(AsyncResult.success({})),
  updateMobilePreferencesAtom: Atom.make({}),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));
vi.mock("../../native/voiceTranscription", () => ({ getLocalVoiceTranscriber: async () => null }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ decodeRecording: async () => new Uint8Array([0, 0]) }),
}));
vi.mock("expo/fetch", () => ({ fetch: mocks.fetch }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "file:///app/" },
  File: class {
    textSync = mocks.markerRead;
    writeSync = mocks.markerWrite;
    delete() {}
    write(id: string) {
      return Promise.resolve().then(() => mocks.markerWrite(id));
    }
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.read,
  setItem: mocks.write,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));
vi.mock("../../lib/uuid", () => {
  let nextGrant = 0;
  return { uuidv4: () => `test-grant-${++nextGrant}` };
});
vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("../../connection/runtime", async () => ({
  connectionAtomRuntime: Atom.runtime((await import("effect/http")).FetchHttpClient.layer),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    presentationAtom: Atom.family((id: string) => {
      mocks.probe(id);
      return Atom.make({
        connection: { phase: id === "offline" ? "offline" : "connected" },
        serverConfig: {
          environment: {
            capabilities: { voiceTranscription: true, cloudVoiceTranscription: true },
          },
        },
      });
    }),
  },
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family((environmentId: string) =>
        Atom.make(
          Option.some({
            environmentId,
            httpBaseUrl: `https://${environmentId}.test`,
            httpAuthorization: { _tag: "Bearer", token: "fixture" },
          }),
        ),
      ),
      sessionStateAtom: Atom.family((_id: string) => Atom.make(true)),
    },
    sessionHasScope: () => true,
  };
});

it.each([
  ["audio", "secure store"],
  ["audio", "marker"],
  ["cleanup", "secure store"],
  ["cleanup", "marker"],
])("revokes %s consent across restarts when writing the %s fails", async (kind, failedStore) => {
  let saved: string | null = null;
  let marker = "";
  mocks.read.mockImplementation(async () => saved);
  mocks.write.mockImplementation((_key: string, value: string) => {
    saved = value;
  });
  mocks.markerRead.mockImplementation(() => marker);
  mocks.markerWrite.mockImplementation((id) => {
    marker = id;
  });
  const host = EnvironmentId.make("my-server");
  const choose = (enabled: boolean) =>
    kind === "audio"
      ? chooseVoiceDestination(enabled ? host : null)
      : chooseTranscriptCleanup(enabled);
  const read = () => (kind === "audio" ? readVoiceGrant() : readVoiceCleanupGrant());
  const current = () =>
    kind === "audio"
      ? appAtomRegistry.get(voiceGrantAtom)
      : appAtomRegistry.get(voiceCleanupGrantAtom);
  try {
    choose(true);
    expect(marker).toBe(kind === "audio" ? appAtomRegistry.get(voiceGrantAtom)?.id : current());
    expect(await read()).not.toBeNull();
    mocks.markerRead.mockReturnValueOnce("");
    expect(await read()).toBeNull();
    const old = { saved, marker };
    const failedWrite = failedStore === "secure store" ? mocks.write : mocks.markerWrite;
    failedWrite.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    choose(false);
    expect(failedStore === "secure store" ? saved : marker).toBe(
      failedStore === "secure store" ? old.saved : old.marker,
    );
    expect(await read()).toBeNull();
    choose(true);
    failedWrite.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    expect(() => choose(true)).toThrow();
    expect(current()).toBeNull();
    expect(await read()).toBeNull();
  } finally {
    mocks.read.mockReset();
    mocks.write.mockReset();
    mocks.markerRead.mockReset();
    mocks.markerWrite.mockReset();
    appAtomRegistry.reset();
  }
});

it("keeps local as the default and never reuses consent for an offline or reselected host", async () => {
  const unmount = appAtomRegistry.mount(voiceRouteAtom);
  try {
    expect(appAtomRegistry.get(voiceRouteAtom)).toBeNull();
    expect(mocks.probe).not.toHaveBeenCalled();
    chooseVoiceDestination(EnvironmentId.make("offline"));
    expect(appAtomRegistry.get(voiceRouteAtom)).toEqual({ transcriber: null });
    const host = EnvironmentId.make("my-server");
    chooseVoiceDestination(host);
    const first = appAtomRegistry.get(voiceRouteAtom)?.transcriber;
    expect(first).toBeTruthy();
    chooseVoiceDestination(null);
    expect(appAtomRegistry.get(voiceRouteAtom)).toBeNull();
    chooseVoiceDestination(host);
    const current = appAtomRegistry.get(voiceRouteAtom)?.transcriber;
    await expect(first!.prepare({ signal: new AbortController().signal })).rejects.toThrow(
      "Your transcription choice changed.",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json({
          supported: true,
          state: "ready",
          modelId: "fixture",
          model: "Fixture",
          size: 1,
          supportsStreaming: false,
          supportsTranslation: false,
          acceleration: "cpu",
          modelUnloadTimeout: "never",
          gpuDevices: [],
        }),
      )
      .mockResolvedValueOnce(Response.json({ text: "hello" }));
    const options = { signal: new AbortController().signal };
    const recording = await current!.prepare(options);
    await expect(recording.transcribe("file:///voice.m4a", options)).resolves.toBe("hello");
    expect(mocks.fetch.mock.calls.map(([url, init]) => [String(url), init?.redirect])).toEqual([
      ["https://my-server.test/api/voice/status", "error"],
      ["https://my-server.test/api/voice/transcribe", "error"],
    ]);
    chooseVoiceDestination(host, "openai");
    const cloud = appAtomRegistry.get(voiceRouteAtom)!.transcriber!;
    mocks.fetch.mockResolvedValueOnce(Response.json({ openai: false, xai: true }));
    await expect(cloud.prepare(options)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("Add your OpenAI API key"),
    });
    mocks.fetch.mockResolvedValueOnce(Response.json({ openai: true, xai: true }));
    const recorded = await cloud.prepare(options);
    chooseVoiceDestination(host, "xai");
    await expect(recorded.transcribe("file:///voice.m4a", options)).rejects.toThrow(
      "Your transcription choice changed.",
    );
    mocks.fetch
      .mockResolvedValueOnce(Response.json({ openai: true, xai: true }))
      .mockResolvedValueOnce(Response.json({ text: "cloud" }));
    const next = await appAtomRegistry.get(voiceRouteAtom)!.transcriber!.prepare(options);
    await expect(next.transcribe("file:///voice.m4a", options)).resolves.toBe("cloud");
    mocks.fetch.mockResolvedValueOnce(
      Response.json(
        {
          _tag: "CloudSpeechError",
          provider: "xai",
          reason: "rejected-key",
        },
        { status: 422 },
      ),
    );
    await expect(next.transcribe("file:///voice.m4a", options)).rejects.toMatchObject({
      _tag: "VoiceTranscriptionError",
      code: "transcription-failed",
      message: expect.stringContaining("rejected this API key"),
    });
    expect(mocks.fetch.mock.calls.slice(2).map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/voice/cloud/keys",
      "/api/voice/cloud/keys",
      "/api/voice/cloud/keys",
      "/api/voice/cloud/xai/transcribe",
      "/api/voice/cloud/xai/transcribe",
    ]);
    // OpenRouter without a model is no destination; with one, the exact id travels with the audio.
    chooseVoiceDestination(host, "openrouter");
    expect(appAtomRegistry.get(voiceRouteAtom)).toBeNull();
    chooseVoiceDestination(host, "openrouter", "acme/transcribe-1");
    mocks.fetch
      .mockResolvedValueOnce(Response.json({ openai: true, xai: true, openrouter: true }))
      .mockResolvedValueOnce(Response.json({ text: "routed" }));
    const routed = await appAtomRegistry.get(voiceRouteAtom)!.transcriber!.prepare(options);
    await expect(routed.transcribe("file:///voice.m4a", options)).resolves.toBe("routed");
    const upload = new URL(String(mocks.fetch.mock.lastCall![0]));
    expect(upload.pathname).toBe("/api/voice/cloud/openrouter/transcribe");
    expect(upload.searchParams.get("model")).toBe("acme/transcribe-1");
    const failWrite = () => {
      throw new Error("Device storage is unavailable");
    };
    mocks.markerWrite.mockImplementationOnce(failWrite);
    mocks.write.mockImplementationOnce(failWrite);
    expect(() => chooseVoiceDestination(null)).toThrow("Device storage is unavailable");
    expect(appAtomRegistry.get(voiceGrantAtom)).toBeNull();
    await expect(current!.prepare(options)).rejects.toThrow("Your transcription choice changed.");
  } finally {
    unmount();
    appAtomRegistry.reset();
  }
});

it("a late cloud key save cannot override a newer destination choice", () => {
  const host = EnvironmentId.make("my-server");
  try {
    chooseVoiceDestination(null);
    const first = pendingCloudVoiceChoice(host, "openai");
    chooseVoiceDestination(null);
    first();
    expect(appAtomRegistry.get(voiceRouteAtom)).toBeNull();
    expect(JSON.parse(mocks.write.mock.lastCall![1])).toBeNull();

    const older = pendingCloudVoiceChoice(host, "openai");
    const newer = pendingCloudVoiceChoice(host, "xai");
    older();
    expect(appAtomRegistry.get(voiceRouteAtom)).toBeNull();
    newer();
    const grant = appAtomRegistry.get(voiceGrantAtom);
    older();
    expect(appAtomRegistry.get(voiceGrantAtom)).toBe(grant);
    expect(grant?.destination).toEqual({ kind: "cloud", environmentId: host, provider: "xai" });
  } finally {
    appAtomRegistry.reset();
  }
});

it.each([
  "off",
  "enabled",
  "failure",
  "different environment",
  "different owner",
  "local",
  "cloud",
  "revoked",
  "re-enabled",
  "enabled after start",
  "bounded context",
  "revoked during cleanup",
  "cancelled during cleanup",
] as const)("dictation through the mobile provider with cleanup %s", async (scenario) => {
  mocks.fetch.mockReset();
  mocks.alert.mockClear();
  const host = EnvironmentId.make("my-server");
  const raw = "um ship twenty four widgets sorry forty two widgets";
  const cleaned = "Ship 42 widgets.";
  const bounded = scenario === "bounded context";
  const context = bounded
    ? `${"a".repeat(2047)} ${"r".repeat(2048)} ${"z".repeat(2047)}`
    : "before replace after";
  const selection = bounded ? { start: 2048, end: 4096 } : { start: 7, end: 14 };
  const commit = vi.fn();
  const cleanup = Promise.withResolvers<Response>();
  const cleanupEntered = Promise.withResolvers<void>();
  const requests: { transcript: string; draft: unknown; options: unknown }[] = [];
  mocks.fetch.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/voice/status")
      return Response.json({
        supported: true,
        state: "ready",
        modelId: "fixture",
        model: "Fixture",
        size: 1,
        supportsStreaming: false,
        supportsTranslation: false,
        acceleration: "cpu",
        modelUnloadTimeout: "never",
        gpuDevices: [],
      });
    if (path === "/api/voice/cloud/keys") return Response.json({ openai: true, xai: true });
    if (path.endsWith("/transcribe")) return Response.json({ text: raw });
    requests.push(JSON.parse(String(init?.body)));
    cleanupEntered.resolve();
    return cleanup.promise;
  });
  chooseTranscriptCleanup(scenario !== "off" && scenario !== "enabled after start");
  chooseVoiceDestination(
    scenario === "local" ? null : host,
    scenario === "cloud" ? "openai" : undefined,
  );
  const { session } = useGlobalVoiceInput();
  appAtomRegistry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe: async () => raw }),
  });
  const target: VoiceInputTarget = {
    ownerKey: "draft-owner",
    environmentId: scenario === "different environment" ? EnvironmentId.make("other-server") : host,
    readDraft: () => ({
      ownerKey: scenario === "different owner" ? "another-owner" : "draft-owner",
      text: context,
      selection,
      revision: 0,
    }),
    commitDraft: commit,
    subscribe: () => () => {},
  };
  try {
    await session.start(target);
    expect(session.controller.currentState.phase).toBe("recording");
    if (scenario === "revoked" || scenario === "re-enabled") chooseTranscriptCleanup(false);
    if (scenario === "re-enabled" || scenario === "enabled after start")
      chooseTranscriptCleanup(true);
    const stopping = session.controller.stop();
    const runsCleanup =
      scenario === "enabled" ||
      scenario === "failure" ||
      bounded ||
      scenario === "revoked during cleanup" ||
      scenario === "cancelled during cleanup";
    if (runsCleanup) {
      await Promise.race([cleanupEntered.promise, stopping]);
      expect(session.getSnapshot().state.phase).toBe("post-processing");
      expect(resolveVoiceComposerPresentation(session.getSnapshot().state, 0).statusLabel).toBe(
        "Cleaning up transcript",
      );
      expect(commit).not.toHaveBeenCalled();
      if (scenario === "revoked during cleanup") chooseTranscriptCleanup(false);
      if (scenario === "cancelled during cleanup") session.cancel(target.ownerKey);
      if (scenario === "failure") cleanup.reject(new Error("provider unavailable"));
      else cleanup.resolve(Response.json({ text: cleaned }));
    }
    await stopping;
    const inserted = scenario === "enabled" || bounded ? cleaned : raw;
    if (scenario === "cancelled during cleanup") expect(commit).not.toHaveBeenCalled();
    else
      expect(commit).toHaveBeenCalledExactlyOnceWith(
        `${context.slice(0, selection.start)}${inserted}${context.slice(selection.end)}`,
        {
          start: selection.start + inserted.length,
          end: selection.start + inserted.length,
        },
      );
    expect(requests).toEqual(
      runsCleanup
        ? [
            {
              transcript: raw,
              draft: bounded
                ? {
                    text: `${"a".repeat(1023)} ${"r".repeat(1024)} ${"z".repeat(1023)}`,
                    selection: { start: 1024, end: 2048 },
                  }
                : { text: context, selection },
              options: {
                speechCustomWords: [],
                speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
              },
            },
          ]
        : [],
    );
    if (runsCleanup) {
      const [url, init] = mocks.fetch.mock.lastCall!;
      expect(String(url)).toBe("https://my-server.test/api/voice/post-process");
      expect(init?.redirect).toBe("error");
    }
    expect(mocks.alert).toHaveBeenCalledTimes(scenario === "failure" ? 1 : 0);
    expect(session.controller.currentState.phase).toBe("idle");
  } finally {
    session.dispose();
    appAtomRegistry.reset();
    mocks.fetch.mockReset();
    mocks.alert.mockClear();
  }
});

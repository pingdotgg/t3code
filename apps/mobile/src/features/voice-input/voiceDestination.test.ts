import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../state/atom-registry";
import { chooseVoiceDestination, voiceRouteAtom } from "./voiceDestination";

const mocks = vi.hoisted(() => ({
  read: vi.fn(async () => null),
  write: vi.fn(),
  probe: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ decodeRecording: async () => new Uint8Array([0, 0]) }),
}));
vi.mock("expo/fetch", () => ({ fetch: mocks.fetch }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.read,
  setItem: mocks.write,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => globalThis.crypto.randomUUID() }));
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
        serverConfig: { environment: { capabilities: { voiceTranscription: true } } },
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
      "destination changed",
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
  } finally {
    unmount();
    appAtomRegistry.reset();
  }
});

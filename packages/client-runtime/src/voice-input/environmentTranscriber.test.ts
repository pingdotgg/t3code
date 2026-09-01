import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  createEnvironmentVoiceTranscriber,
  type EnvironmentVoiceTranscriptionTransport,
} from "./environmentTranscriber.ts";

const environmentId = EnvironmentId.make("environment-1");
const registry = {} as Parameters<typeof createEnvironmentVoiceTranscriber>[0]["registry"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function defaultTransport(): EnvironmentVoiceTranscriptionTransport {
  return {
    sizeBytes: vi.fn(async () => 3),
    upload: vi.fn(async () => ({
      status: 200,
      bodyText: JSON.stringify({ text: "hello from OpenAI" }),
    })),
  };
}

function transcriber(input: {
  readonly services?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly connected?: boolean;
  readonly createUrl?: Parameters<
    typeof createEnvironmentVoiceTranscriber
  >[0]["environment"]["createUrl"];
  readonly transport?: EnvironmentVoiceTranscriptionTransport;
}) {
  return createEnvironmentVoiceTranscriber({
    environmentId,
    serviceId: "openai",
    locale: "en-US",
    mimeType: "audio/mp4",
    transport: input.transport ?? defaultTransport(),
    registry,
    environment: {
      createUrl:
        input.createUrl ??
        ({
          label: "test:transcription:create-url",
          run: async () =>
            AsyncResult.success({
              relativeUrl: "/api/transcription/token",
              expiresAt: 1,
            }),
        } as Parameters<typeof createEnvironmentVoiceTranscriber>[0]["environment"]["createUrl"]),
    },
    getServices: () => input.services ?? [{ id: "openai", label: "OpenAI" }],
    isConnected: () => input.connected ?? true,
    resolveUrl: (relativeUrl) => `https://environment.test${relativeUrl}`,
  });
}

describe("createEnvironmentVoiceTranscriber", () => {
  it("mints with file metadata, uploads through the transport, and returns the transcript", async () => {
    const transport = defaultTransport();
    const createUrl = {
      label: "test:transcription:create-url",
      run: vi.fn(async () =>
        AsyncResult.success({
          relativeUrl: "/api/transcription/token",
          expiresAt: 1,
        }),
      ),
    } as Parameters<typeof createEnvironmentVoiceTranscriber>[0]["environment"]["createUrl"];
    const abort = new AbortController();
    const prepared = await transcriber({ createUrl, transport }).prepare({ signal: abort.signal });

    await expect(prepared.transcribe("file:///voice.m4a", { signal: abort.signal })).resolves.toBe(
      "hello from OpenAI",
    );
    expect(transport.sizeBytes).toHaveBeenCalledWith("file:///voice.m4a");
    expect(createUrl.run).toHaveBeenCalledWith(
      registry,
      {
        environmentId,
        input: { mimeType: "audio/mp4", sizeBytes: 3, locale: "en-US" },
      },
      abort.signal,
    );
    expect(transport.upload).toHaveBeenCalledWith({
      uri: "file:///voice.m4a",
      url: "https://environment.test/api/transcription/token",
      mimeType: "audio/mp4",
      signal: abort.signal,
    });
  });

  it("cancels while minting the upload URL", async () => {
    const createUrl = {
      label: "test:transcription:create-url",
      run: async (_registry: unknown, _input: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("mint aborted")), {
            once: true,
          });
        }),
    } as Parameters<typeof createEnvironmentVoiceTranscriber>[0]["environment"]["createUrl"];
    const abort = new AbortController();
    const prepared = await transcriber({ createUrl }).prepare({ signal: abort.signal });
    const pending = prepared.transcribe("file:///voice.m4a", { signal: abort.signal });
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels the injected transcription upload", async () => {
    const uploadStarted = deferred<void>();
    const transport: EnvironmentVoiceTranscriptionTransport = {
      sizeBytes: async () => 1,
      upload: ({ signal }) => {
        uploadStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("upload aborted")), {
            once: true,
          });
        });
      },
    };
    const abort = new AbortController();
    const prepared = await transcriber({ transport }).prepare({ signal: abort.signal });
    const pending = prepared.transcribe("file:///voice.m4a", { signal: abort.signal });
    await uploadStarted.promise;
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports unavailable when the selected service is no longer advertised", async () => {
    await expect(
      transcriber({ services: [] }).prepare({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

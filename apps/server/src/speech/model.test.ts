// @effect-diagnostics nodeBuiltinImport:off - exercises sparse native model files without downloading a model.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  downloadSpeechModel,
  effectiveSpeechLanguage,
  isSpeechModelReady,
  SPEECH_MODELS,
} from "./model.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("speech model catalog", () => {
  it("contains unique ids and filenames", () => {
    expect(new Set(SPEECH_MODELS.map((model) => model.id)).size).toBe(SPEECH_MODELS.length);
    expect(new Set(SPEECH_MODELS.map((model) => model.filename)).size).toBe(SPEECH_MODELS.length);
  });

  it("offers Handy's complete pinned catalog with five recommended models", () => {
    expect(SPEECH_MODELS).toHaveLength(69);
    expect(SPEECH_MODELS.filter((model) => model.recommended)).toHaveLength(5);
    for (const model of SPEECH_MODELS) {
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.filename).toMatch(/\.gguf$/);
      expect(model.size).toBeGreaterThan(0);
      expect(model.languages.length).toBeGreaterThan(0);
    }
  });

  it("preserves Handy's translation capabilities without advertising streaming translation", () => {
    expect(
      SPEECH_MODELS.find((model) => model.name === "Whisper Medium")?.supportsTranslation,
    ).toBe(true);
    expect(
      SPEECH_MODELS.find((model) => model.name === "Parakeet Unified EN 0.6B")?.supportsTranslation,
    ).toBe(false);
    expect(
      SPEECH_MODELS.filter((model) => model.supportsStreaming && model.supportsTranslation),
    ).toEqual([]);
  });
});

it("resolves Auto only for models that can detect language", () => {
  const canary = SPEECH_MODELS.find((model) => model.name === "Canary 180M Flash")!;
  const whisper = SPEECH_MODELS.find((model) => model.name === "Whisper Medium")!;
  expect(effectiveSpeechLanguage(canary, "auto")).toBe("en");
  expect(effectiveSpeechLanguage(canary, "es")).toBe("es");
  expect(effectiveSpeechLanguage(whisper, "auto")).toBe("auto");
  expect(effectiveSpeechLanguage(whisper, "fr")).toBe("fr");
});

it("checks readiness without reading the model contents", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "speech-status-"));
  try {
    const speechModel = SPEECH_MODELS[0]!;
    const path = NodePath.join(directory, speechModel.filename);
    expect(await isSpeechModelReady(directory, speechModel)).toBe(false);
    await NodeFSP.writeFile(path, "");
    await NodeFSP.truncate(path, speechModel.size);
    expect(await isSpeechModelReady(directory, speechModel)).toBe(true);
    await NodeFSP.truncate(path, 1);
    expect(await isSpeechModelReady(directory, speechModel)).toBe(false);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("resumes a model download after the response ends early", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "speech-download-"));
  const bytes = Buffer.from("a verified speech model");
  const model = {
    ...SPEECH_MODELS[0]!,
    filename: "test.gguf",
    size: bytes.length,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
  let requests = 0;
  const fetchModel = vi.fn(async (_url: string, options?: RequestInit) => {
    requests += 1;
    if (requests === 1) {
      return new Response(bytes.subarray(0, 8), {
        headers: { "content-length": String(bytes.length) },
      });
    }
    expect(options?.headers).toEqual({ Range: "bytes=8-" });
    return new Response(bytes.subarray(8), {
      status: 206,
      headers: {
        "content-length": String(bytes.length - 8),
        "content-range": `bytes 8-${bytes.length - 1}/${bytes.length}`,
      },
    });
  });
  vi.stubGlobal("fetch", fetchModel);
  try {
    const path = await downloadSpeechModel(directory, model);
    expect(await NodeFSP.readFile(path)).toEqual(bytes);
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(await NodeFSP.readdir(directory)).toEqual([
      model.filename,
      `${model.filename}.verified`,
    ]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("retries a terminated model connection", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "speech-retry-"));
  const bytes = Buffer.from("speech model");
  const model = {
    ...SPEECH_MODELS[0]!,
    filename: "retry.gguf",
    size: bytes.length,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const fetchModel = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("terminated"))
    .mockResolvedValueOnce(
      new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
    );
  vi.stubGlobal("fetch", fetchModel);
  try {
    expect(await NodeFSP.readFile(await downloadSpeechModel(directory, model))).toEqual(bytes);
    expect(fetchModel).toHaveBeenCalledTimes(2);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("reuses verification only while the model file and expected digest are unchanged", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "speech-verified-"));
  const bytes = Buffer.from("verified model");
  const model = {
    ...SPEECH_MODELS[0]!,
    filename: "cached.gguf",
    size: bytes.length,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const fetchModel = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetchModel);
  const read = vi.spyOn(NodeFS, "createReadStream");
  try {
    const path = await downloadSpeechModel(directory, model);
    expect(read).toHaveBeenCalledTimes(1);
    await downloadSpeechModel(directory, model);
    expect(read).toHaveBeenCalledTimes(1);
    expect(fetchModel).toHaveBeenCalledTimes(1);
    await NodeFSP.writeFile(path, Buffer.alloc(bytes.length));
    await NodeFSP.utimes(path, 0, 0);
    expect(await NodeFSP.readFile(await downloadSpeechModel(directory, model))).toEqual(bytes);
    expect(read).toHaveBeenCalledTimes(3);
    expect(fetchModel).toHaveBeenCalledTimes(2);
    await expect(
      downloadSpeechModel(directory, { ...model, sha256: "0".repeat(64) }),
    ).rejects.toThrow("verification failed");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

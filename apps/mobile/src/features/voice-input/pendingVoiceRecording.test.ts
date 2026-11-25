import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    readonly uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    get exists() {
      return files.has(this.uri);
    }
    textSync() {
      const value = files.get(this.uri);
      if (value === undefined) throw new Error(`ENOENT: ${this.uri}`);
      return value;
    }
    writeSync(contents: string) {
      files.set(this.uri, contents);
    }
    delete() {
      files.delete(this.uri);
    }
  },
}));

import {
  clearPendingVoiceRecording,
  clearPendingVoiceRecordingForUri,
  readPendingVoiceRecording,
  writePendingVoiceRecording,
  type StoredPendingVoiceRecording,
} from "./pendingVoiceRecording";

const sampleRecording: StoredPendingVoiceRecording = {
  uri: "file:///cache/recording-1.m4a",
  ownerKey: "env:thread-1",
  label: "Thread 1",
  startText: "hello",
  selection: { start: 5, end: 5 },
  grantId: null,
  recordedAt: 1_000_000,
};

describe("pendingVoiceRecording", () => {
  beforeEach(() => files.clear());

  it("round-trips a saved recording while its audio file exists", () => {
    files.set(sampleRecording.uri, "m4a-bytes");
    writePendingVoiceRecording(sampleRecording);

    expect(readPendingVoiceRecording(sampleRecording.recordedAt + 1_000)).toEqual(sampleRecording);

    writePendingVoiceRecording(null);
    expect(readPendingVoiceRecording(sampleRecording.recordedAt + 1_000)).toBeNull();
    expect(files.has(sampleRecording.uri)).toBe(true);
  });

  it("clears the manifest when the audio file is missing or expired", () => {
    writePendingVoiceRecording(sampleRecording);
    expect(readPendingVoiceRecording(sampleRecording.recordedAt + 1_000)).toBeNull();
    expect(files.size).toBe(0);

    files.set(sampleRecording.uri, "m4a-bytes");
    writePendingVoiceRecording(sampleRecording);
    expect(readPendingVoiceRecording(sampleRecording.recordedAt + 25 * 60 * 60 * 1000)).toBeNull();
    expect(files.size).toBe(0);
  });

  it("deletes both manifest and audio when cleared with deleteAudio", () => {
    files.set(sampleRecording.uri, "m4a-bytes");
    writePendingVoiceRecording(sampleRecording);

    clearPendingVoiceRecording(true);
    expect(files.size).toBe(0);
  });

  it("preserves recordedAt on rewrites for the same URI and only clears matching manifests", () => {
    files.set(sampleRecording.uri, "m4a-bytes");
    writePendingVoiceRecording(sampleRecording);
    writePendingVoiceRecording({
      ...sampleRecording,
      recordedAt: sampleRecording.recordedAt + 60_000,
    });
    expect(readPendingVoiceRecording(sampleRecording.recordedAt + 120_000)?.recordedAt).toBe(
      sampleRecording.recordedAt,
    );

    const oldUri = "file:///cache/older.m4a";
    files.set(oldUri, "old-bytes");
    clearPendingVoiceRecordingForUri(oldUri, true);
    expect(files.has(oldUri)).toBe(false);
    expect(readPendingVoiceRecording(sampleRecording.recordedAt + 120_000)?.uri).toBe(
      sampleRecording.uri,
    );
  });
});

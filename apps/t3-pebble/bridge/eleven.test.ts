import { expect, test } from "bun:test";
import eleven from "../src/pkjs/eleven.js";
import { installStorage } from "./xhr-shim.ts";

class RecordingXhr {
  static count = 0;
  static last: RecordingXhr | null = null;
  status = 200;
  responseType = "";
  response: ArrayBuffer = new Uint8Array([1, 2]).buffer;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url = "";
  headers: Record<string, string> = {};
  body = "";

  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader() {
    return null;
  }
  send(body: string) {
    RecordingXhr.count++;
    RecordingXhr.last = this;
    this.body = body;
    this.onload?.();
  }
}

function installRecordingXhr() {
  const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = RecordingXhr;
  return () => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
  };
}

test("speaks through ElevenLabs with the saved key and 8000 Hz PCM", async () => {
  const storage = installStorage({ elevenKey: "eleven-key" });
  const restore = installRecordingXhr();
  try {
    RecordingXhr.count = 0;
    const data = await new Promise<ArrayBuffer | null>((resolve, reject) => {
      eleven.speak("hello", (error: Error | null, value: ArrayBuffer | null) =>
        error ? reject(error) : resolve(value),
      );
    });
    expect(RecordingXhr.count).toBe(1);
    expect(RecordingXhr.last!.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=pcm_8000",
    );
    expect(RecordingXhr.last!.headers).toMatchObject({
      "xi-api-key": "eleven-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(RecordingXhr.last!.body)).toEqual({
      text: "hello",
      model_id: "eleven_flash_v2_5",
    });
    expect(new Uint8Array(data!)).toEqual(new Uint8Array([1, 2]));
  } finally {
    restore();
    storage.restore();
  }
});

test("stays quiet without a key", async () => {
  const storage = installStorage();
  const restore = installRecordingXhr();
  try {
    RecordingXhr.count = 0;
    const data = await new Promise<ArrayBuffer | null>((resolve, reject) => {
      eleven.speak("hello", (error: Error | null, value: ArrayBuffer | null) =>
        error ? reject(error) : resolve(value),
      );
    });
    expect(data).toBeNull();
    expect(RecordingXhr.count).toBe(0);
  } finally {
    restore();
    storage.restore();
  }
});

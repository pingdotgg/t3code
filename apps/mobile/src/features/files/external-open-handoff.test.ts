import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isForegroundHandoffActive } from "../../lib/foreground-handoff";
import { downloadHandoffFile, launchExternalViewer } from "./external-open-handoff";

const fake = vi.hoisted(() => {
  const state = {
    directories: new Set<string>(),
    files: new Set<string>(),
    nextDownload: null as
      | null
      | ((options: {
          onProgress?: (data: { bytesWritten: number; totalBytes: number }) => void;
          signal?: AbortSignal;
        }) => Promise<void>),
    appStateListeners: [] as Array<(state: string) => void>,
    launchSettlers: [] as Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
  };

  class FakeDirectory {
    readonly uri: string;
    constructor(...parts: Array<string | FakeDirectory>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return state.directories.has(this.uri);
    }
    create() {
      // Mirrors { intermediates: true }: parents exist too.
      const segments = this.uri.split("/");
      for (let index = 1; index <= segments.length; index += 1) {
        state.directories.add(segments.slice(0, index).join("/"));
      }
    }
    delete() {
      for (const uri of Array.from(state.directories)) {
        if (uri === this.uri || uri.startsWith(`${this.uri}/`)) {
          state.directories.delete(uri);
        }
      }
      for (const uri of Array.from(state.files)) {
        if (uri.startsWith(`${this.uri}/`)) {
          state.files.delete(uri);
        }
      }
    }
  }

  class FakeFile {
    readonly uri: string;
    constructor(directory: FakeDirectory, name: string) {
      this.uri = `${directory.uri}/${name}`;
    }
    get contentUri() {
      return `content://fake${this.uri}`;
    }
    static async downloadFileAsync(
      _url: string,
      destination: FakeFile,
      options: {
        onProgress?: (data: { bytesWritten: number; totalBytes: number }) => void;
        signal?: AbortSignal;
      } = {},
    ) {
      if (state.nextDownload) {
        await state.nextDownload(options);
      }
      state.files.add(destination.uri);
      return destination;
    }
  }

  return { state, FakeDirectory, FakeFile };
});

vi.mock("expo-file-system", () => ({
  Directory: fake.FakeDirectory,
  File: fake.FakeFile,
  Paths: { cache: new fake.FakeDirectory("cache") },
}));
vi.mock("expo-intent-launcher", () => ({
  startActivityAsync: vi.fn(
    () =>
      new Promise((resolve, reject) => {
        fake.state.launchSettlers.push({ resolve, reject });
      }),
  ),
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      fake.state.appStateListeners.push(listener);
      return {
        remove: () => {
          fake.state.appStateListeners = fake.state.appStateListeners.filter(
            (entry) => entry !== listener,
          );
        },
      };
    },
  },
}));
vi.mock("../../lib/uuid", () => {
  let next = 0;
  return { uuidv4: () => `uuid-${++next}` };
});

const handoffFiles = () =>
  [...fake.state.files].filter((uri) => uri.startsWith("cache/external-open-handoff/"));

describe("downloadHandoffFile", () => {
  beforeEach(() => {
    fake.state.directories.clear();
    fake.state.files.clear();
    fake.state.nextDownload = null;
  });

  it("keeps at most one completed handoff file across downloads", async () => {
    const signal = new AbortController().signal;
    const first = await downloadHandoffFile("https://server/a", "scene.glb", signal);
    expect(first.contentUri).toMatch(/^content:\/\/fake.*scene\.glb$/);
    expect(handoffFiles()).toHaveLength(1);

    const second = await downloadHandoffFile("https://server/b", "other.glb", signal);
    expect(second.contentUri).toContain("other.glb");
    expect(handoffFiles()).toHaveLength(1);
    expect(handoffFiles()[0]).toContain("other.glb");
  });

  it("deletes the partial file and maps the failure to product copy", async () => {
    fake.state.nextDownload = () => Promise.reject(new Error("response has status: 404"));

    await expect(
      downloadHandoffFile("https://server/a", "scene.glb", new AbortController().signal),
    ).rejects.toThrow("The file could not be downloaded.");
    expect(handoffFiles()).toHaveLength(0);
  });

  it("aborts past the size cap with a finite too-large error", async () => {
    fake.state.nextDownload = ({ onProgress, signal }) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        onProgress?.({ bytesWritten: 101 * 1024 * 1024, totalBytes: -1 });
      });

    await expect(
      downloadHandoffFile("https://server/a", "scene.glb", new AbortController().signal),
    ).rejects.toThrow("The file is too large to open in another app.");
    expect(handoffFiles()).toHaveLength(0);
  });

  it("refuses to start when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      downloadHandoffFile("https://server/a", "scene.glb", abort.signal),
    ).rejects.toThrow("The download was cancelled.");
    expect(handoffFiles()).toHaveLength(0);
    expect(fake.state.directories.size).toBe(0);
  });

  it("propagates a caller abort unchanged so a disposed screen stays silent", async () => {
    const abort = new AbortController();
    fake.state.nextDownload = ({ signal }) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        abort.abort();
      });

    await expect(
      downloadHandoffFile("https://server/a", "scene.glb", abort.signal),
    ).rejects.toThrow("AbortError");
    expect(handoffFiles()).toHaveLength(0);
  });
});

describe("launchExternalViewer", () => {
  it("holds the foreground handoff for the viewer session and releases on return", async () => {
    const launch = launchExternalViewer({
      contentUri: "content://fake/scene.glb",
      mimeType: "model/gltf-binary",
    });
    await vi.waitFor(() => expect(fake.state.launchSettlers.length).toBeGreaterThan(0));
    expect(isForegroundHandoffActive()).toBe(true);

    // Coming back to the foreground releases the handoff even when the
    // activity result never arrives.
    for (const listener of fake.state.appStateListeners) {
      listener("active");
    }
    expect(isForegroundHandoffActive()).toBe(false);

    fake.state.launchSettlers.pop()?.resolve({ resultCode: 0 });
    await launch;
    expect(isForegroundHandoffActive()).toBe(false);
  });
});

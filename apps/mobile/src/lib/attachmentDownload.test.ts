import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  directories: new Set<string>(),
  deleted: vi.fn(),
  download: vi.fn(),
  copy: vi.fn(),
  share: vi.fn(),
  shareFromSource: vi.fn(),
  available: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(...parts: Array<string | Directory>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }

    get name(): string {
      return this.uri.split("/").at(-1)!;
    }

    get exists(): boolean {
      return mocks.directories.has(this.uri);
    }

    create(): void {
      mocks.directories.add(this.uri);
    }

    list(): Directory[] {
      const prefix = `${this.uri}/`;
      return [...mocks.directories]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new Directory(uri));
    }

    delete(): void {
      mocks.deleted(this.uri);
      mocks.directories.delete(this.uri);
    }
  }

  class File {
    static downloadFileAsync = mocks.download;
    readonly uri: string;

    constructor(source: Directory | string, name?: string) {
      this.uri = typeof source === "string" ? source : `${source.uri}/${encodeURIComponent(name!)}`;
    }

    async copy(destination: File): Promise<void> {
      await mocks.copy(this.uri, destination.uri);
    }
  }

  return { Directory, File, Paths: { cache: "file:///cache" } };
});

vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.available,
  shareAsync: mocks.share,
}));

vi.mock("./uuid", () => ({ uuidv4: mocks.uuid }));
vi.mock("./shareFileFromSource", () => ({ shareFileFromSource: mocks.shareFromSource }));

import {
  downloadAndShareAttachment,
  downloadAttachmentForPreview,
  shareLocalAttachment,
} from "./attachmentDownload";
import { isForegroundHandoffActive } from "./foreground-handoff";

const NOW = 1_787_990_400_000;
const DAY_MS = 24 * 60 * 60_000;
const CACHE = "file:///cache/t3-attachment-downloads";
const input = {
  url: "https://chosen-environment.example/api/assets/signed-token/report.pdf",
  attachment: { name: "report.pdf", mimeType: "application/pdf" },
};

beforeEach(() => {
  mocks.directories.clear();
  mocks.deleted.mockReset();
  mocks.download.mockReset();
  mocks.copy.mockReset();
  mocks.share.mockReset();
  mocks.shareFromSource.mockReset();
  mocks.available.mockReset();
  mocks.uuid.mockReset();
  mocks.download.mockImplementation(async (_url: string, file: { uri: string }) => file);
  mocks.copy.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue(undefined);
  mocks.shareFromSource.mockResolvedValue(undefined);
  mocks.available.mockResolvedValue(true);
  let sequence = 0;
  mocks.uuid.mockImplementation(
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  );
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(isForegroundHandoffActive()).toBe(false);
});

describe("downloadAndShareAttachment", () => {
  it("downloads the chosen environment's signed URL and shares the local file", async () => {
    const controller = new AbortController();
    await downloadAndShareAttachment({ ...input, signal: controller.signal });

    expect(mocks.download).toHaveBeenCalledWith(
      input.url,
      expect.objectContaining({ uri: expect.stringMatching(/\/report\.pdf$/) }),
      { signal: controller.signal },
    );
    expect(mocks.share).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/cache\/.+\/report\.pdf$/),
      {
        mimeType: "application/pdf",
        dialogTitle: "report.pdf",
      },
    );
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("shares videos even when the server serves their bytes inline", async () => {
    await downloadAndShareAttachment({
      url: "https://relay-environment.example/api/assets/signed-video/clip.mp4",
      attachment: { name: "clip.mp4", mimeType: 'video/mp4; codecs="avc1"' },
      signal: new AbortController().signal,
    });

    expect(mocks.share).toHaveBeenCalledWith(expect.stringMatching(/\/clip\.mp4$/), {
      mimeType: "video/mp4",
      dialogTitle: "clip.mp4",
    });
  });

  it.each([
    ["../../résumé.pdf", "résumé.pdf"],
    ["C:\\folder\\clip.mp4", "clip.mp4"],
    ["a?query#part%2F.txt", "a?query#part%2F.txt"],
    ["Report #5 - 100%.pdf", "Report #5 - 100%.pdf"],
    ["..", "attachment"],
    ["  ", "attachment"],
    ["\ud800file\u0000.txt", "_file_.txt"],
    [".env", ".env"],
  ])("uses a safe basename for %j", async (name, expected) => {
    await downloadAndShareAttachment({
      ...input,
      attachment: { ...input.attachment, name },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    expect(decodeURIComponent(file.uri.split("/").at(-1)!)).toBe(expected);
  });

  it("preserves ordinary long filenames that fit within the filesystem limit", async () => {
    const name =
      "Project quarterly report with detailed implementation and delivery notes for August 2026.pdf";
    await downloadAndShareAttachment({
      ...input,
      attachment: { ...input.attachment, name },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    expect(decodeURIComponent(file.uri.split("/").at(-1)!)).toBe(name);
  });

  it("bounds the UTF-8 filename length while preserving its extension", async () => {
    await downloadAndShareAttachment({
      ...input,
      attachment: { name: `${"🙂".repeat(80)}.mp4`, mimeType: "video/mp4" },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    const name = decodeURIComponent(file.uri.split("/").at(-1)!);
    expect(name.endsWith(".mp4")).toBe(true);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  });

  it("reports unavailable sharing before downloading or creating files", async () => {
    mocks.available.mockResolvedValue(false);
    await expect(
      downloadAndShareAttachment({ ...input, signal: new AbortController().signal }),
    ).rejects.toThrow("Saving and sharing files is unavailable on this device.");
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.directories.size).toBe(0);
  });

  it("cleans an interrupted download only after the native request settles", async () => {
    const started = Promise.withResolvers<void>();
    const download = Promise.withResolvers<{ uri: string }>();
    mocks.download.mockImplementation(() => {
      started.resolve();
      return download.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({ ...input, signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    download.reject(new Error("Canceled native request"));
    await task;
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("does not open a late download after cancellation", async () => {
    const started = Promise.withResolvers<{ uri: string }>();
    const download = Promise.withResolvers<{ uri: string }>();
    mocks.download.mockImplementation((_url: string, file: { uri: string }) => {
      started.resolve(file);
      return download.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({ ...input, signal: controller.signal });
    const file = await started.promise;
    controller.abort();
    download.resolve(file);
    await task;
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it("retains an export when its row unmounts during the native handoff", async () => {
    const opened = Promise.withResolvers<void>();
    const share = Promise.withResolvers<void>();
    mocks.share.mockImplementation(() => {
      expect(isForegroundHandoffActive()).toBe(true);
      opened.resolve();
      return share.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({ ...input, signal: controller.signal });
    await opened.promise;
    controller.abort();
    share.resolve();
    await task;
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("cleans failed exports and releases the foreground handoff", async () => {
    mocks.share.mockRejectedValue(new Error("No activity can open this file"));
    await expect(
      downloadAndShareAttachment({ ...input, signal: new AbortController().signal }),
    ).rejects.toThrow("Could not open the share sheet. Try again.");
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it("removes expired exports while leaving recent and unrelated cache entries alone", async () => {
    const old = `${CACHE}/${NOW - DAY_MS - 1}-00000000-0000-4000-8000-000000000010`;
    const recent = `${CACHE}/${NOW - DAY_MS + 1}-00000000-0000-4000-8000-000000000011`;
    const unrelated = `${CACHE}/unrelated`;
    mocks.directories.add(old).add(recent).add(unrelated);

    await downloadAndShareAttachment({ ...input, signal: new AbortController().signal });
    expect(mocks.deleted.mock.calls).toEqual([[old]]);
    expect(mocks.directories.has(recent)).toBe(true);
    expect(mocks.directories.has(unrelated)).toBe(true);
  });

  it("does not prune an active export even if it passes the cache expiry", async () => {
    const opened = Promise.withResolvers<void>();
    const share = Promise.withResolvers<void>();
    mocks.share.mockImplementationOnce(() => {
      opened.resolve();
      return share.promise;
    });
    const first = downloadAndShareAttachment({ ...input, signal: new AbortController().signal });
    await opened.promise;
    vi.mocked(Date.now).mockReturnValue(NOW + DAY_MS + 1);

    await downloadAndShareAttachment({ ...input, signal: new AbortController().signal });
    expect(mocks.deleted).not.toHaveBeenCalled();
    share.resolve();
    await first;
  });
});

describe("attachment preview files", () => {
  it("does not start a native request after cancellation during setup", async () => {
    const controller = new AbortController();
    const loading = downloadAttachmentForPreview({ ...input, signal: controller.signal });
    controller.abort();
    await expect(loading).resolves.toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("downloads for playback without requiring a share sheet and removes the file on close", async () => {
    mocks.available.mockResolvedValue(false);
    const file = await downloadAttachmentForPreview({
      ...input,
      signal: new AbortController().signal,
    });
    expect(file?.uri.endsWith("/report.pdf")).toBe(true);
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
    file?.dispose();
    file?.dispose();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "share-button"])(
    "keeps a shared preview after its owner closes (source: %s)",
    async (sourceIdentifier) => {
      const opened = Promise.withResolvers<void>();
      const sharing = Promise.withResolvers<void>();
      const nativeShare = sourceIdentifier ? mocks.shareFromSource : mocks.share;
      nativeShare.mockImplementationOnce(() => {
        opened.resolve();
        return sharing.promise;
      });
      const file = await downloadAttachmentForPreview({
        ...input,
        signal: new AbortController().signal,
      });
      const share = file!.share(new AbortController().signal, sourceIdentifier);
      await opened.promise;
      file!.dispose();
      expect(mocks.deleted).not.toHaveBeenCalled();
      expect(isForegroundHandoffActive()).toBe(true);
      sharing.resolve();
      await share;
      expect(isForegroundHandoffActive()).toBe(false);
      expect(mocks.deleted).not.toHaveBeenCalled();
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.copy).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "share-button"])(
    "does not share a disposed preview after availability checking (source: %s)",
    async (sourceIdentifier) => {
      const checking = Promise.withResolvers<void>();
      const available = Promise.withResolvers<boolean>();
      mocks.available.mockImplementation(() => {
        checking.resolve();
        return available.promise;
      });
      const file = await downloadAttachmentForPreview({
        ...input,
        signal: new AbortController().signal,
      });
      const share = file!.share(new AbortController().signal, sourceIdentifier);
      await checking.promise;
      file!.dispose();
      available.resolve(true);
      await share;
      expect(mocks.share).not.toHaveBeenCalled();
      expect(mocks.shareFromSource).not.toHaveBeenCalled();
      expect(mocks.deleted).toHaveBeenCalledTimes(1);
    },
  );

  it("copies a local original before sharing without downloading or deleting the source", async () => {
    const uri = "file:///documents/draft/report.pdf";
    await shareLocalAttachment({
      uri,
      attachment: input.attachment,
      signal: new AbortController().signal,
    });
    expect(mocks.copy).toHaveBeenCalledWith(
      uri,
      expect.stringMatching(/^file:\/\/\/cache\/.+\/report\.pdf$/),
    );
    expect(mocks.share).toHaveBeenCalledWith(mocks.copy.mock.calls[0]![1], expect.any(Object));
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("waits for a local copy to finish before cleaning up a canceled share", async () => {
    const copying = Promise.withResolvers<void>();
    const copied = Promise.withResolvers<void>();
    mocks.copy.mockImplementation(() => {
      copying.resolve();
      return copied.promise;
    });
    const controller = new AbortController();
    const task = shareLocalAttachment({
      uri: "file:///documents/draft/report.pdf",
      attachment: input.attachment,
      signal: controller.signal,
    });
    await copying.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    copied.resolve();
    await task;
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });
});

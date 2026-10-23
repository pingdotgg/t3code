import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type UploadOptions = {
  signal: AbortSignal;
  onProgress?: (progress: { bytesSent: number; totalBytes: number }) => void;
};
type DraftFault = "decode" | "read" | "write" | null;

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  server: new Map<string, Uint8Array | null>(),
  deleted: [] as string[],
  fault: null as DraftFault,
  canOperate: true,
  nextId: 0,
  nextUuid: 0,
  mint: Symbol("mint"),
  remove: Symbol("remove"),
  transfer:
    vi.fn<(uri: string, url: string, options: UploadOptions) => Promise<{ status: number }>>(),
  effects: [] as Array<() => void | (() => void)>,
  queueRef: {
    current: null as ReturnType<
      typeof import("../lib/composerAttachmentUploadQueue").createComposerAttachmentUploadQueue
    > | null,
  },
}));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => native.effects.push(effect),
  useRef: () => native.queueRef,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Parameters<typeof appAtomRegistry.get>[0]) => appAtomRegistry.get(atom),
}));
vi.mock("expo-file-system", () => {
  const uriOf = (parent: string | { uri: string }) =>
    typeof parent === "string" ? parent : parent.uri;
  class Directory {
    readonly uri: string;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = [uriOf(parent), name].filter(Boolean).join("/");
    }
    create() {}
    list() {
      return [...native.files.keys()]
        .filter((uri) => uri.startsWith(`${this.uri}/`))
        .map((uri) => new File(uri));
    }
  }
  class File {
    readonly uri: string;
    readonly name: string;
    readonly parentDirectory: Directory;
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = [uriOf(parent), name].filter(Boolean).join("/");
      this.name = this.uri.split("/").at(-1)!;
      this.parentDirectory = new Directory(this.uri.slice(0, this.uri.lastIndexOf("/")));
    }
    get exists() {
      return native.files.has(this.uri);
    }
    create() {
      native.files.set(this.uri, new Uint8Array());
    }
    async text() {
      if (native.fault === "read" && this.uri.endsWith("/composer-drafts/drafts.json")) {
        throw new Error("EACCES: drafts.json");
      }
      return Buffer.from(native.files.get(this.uri)!).toString("utf8");
    }
    write(value: string, options?: { encoding?: string }) {
      if (native.fault === "write" && this.uri.includes("/composer-drafts/")) {
        throw new Error("ENOSPC");
      }
      native.files.set(
        this.uri,
        Buffer.from(value, options?.encoding === "base64" ? "base64" : "utf8"),
      );
    }
    moveSync(destination: File) {
      native.files.set(destination.uri, native.files.get(this.uri)!);
      native.files.delete(this.uri);
    }
    delete() {
      native.files.delete(this.uri);
    }
    upload(url: string, options: UploadOptions) {
      return native.transfer(this.uri, url, options);
    }
  }
  return {
    Directory,
    File,
    Paths: { document: new Directory("file:///documents"), cache: new Directory("file:///cache") },
    UploadType: { BINARY_CONTENT: 0 },
  };
});
vi.mock("../lib/uuid", () => ({
  uuidv4: () => `upload-${++native.nextUuid}`,
  randomHex: () => "abcd",
}));
vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: async () => [],
}));
vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map([["environment-1", config]]),
  useThreadShells: () => [],
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { configValueAtom: Atom.family(() => Atom.make(null)) } };
});
vi.mock("./git", () => ({ gitEnvironment: {} }));
vi.mock("./threads", () => ({ threadEnvironment: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));
vi.mock("./session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    readEnvironmentScope: () => native.canOperate,
    useEnvironmentsWithScope: () => new Set(["environment-1"]),
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() =>
        Atom.make(Option.some({ httpBaseUrl: "https://environment.example/" })),
      ),
    },
  };
});
vi.mock("./attachments", () => ({
  attachmentEnvironment: { createUploadUrl: native.mint, remove: native.remove },
}));
vi.mock("./assets", () => ({ assetEnvironment: { createUrl: (input: unknown) => input } }));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  // The worker settles uploads with the real settlePromise and squashAtomCommandFailure;
  // only the RPC transport is substituted.
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: async (
    _registry: unknown,
    query: { input: { resource: { attachmentId: string } } },
  ) =>
    native.server.get(query.input.resource.attachmentId)
      ? { _tag: "Success", value: {} }
      : { _tag: "Failure", error: { _tag: "AssetAttachmentNotFoundError" } },
  runAtomCommand: async (
    _registry: unknown,
    command: unknown,
    target: { input: { attachmentId?: string } },
  ) => {
    if (command === native.mint) {
      const id = `pending-${++native.nextId}`;
      native.server.set(id, null);
      return {
        _tag: "Success",
        value: { attachmentId: id, relativeUrl: `/upload/${id}`, expiresAt: 1 },
      };
    }
    if (command === native.remove && target.input.attachmentId) {
      native.deleted.push(target.input.attachmentId);
      native.server.delete(target.input.attachmentId);
      return { _tag: "Success", value: undefined };
    }
    throw new Error("Unexpected RPC command");
  },
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, boolean>>({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<Record<string, string>>({}).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () =>
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map(),
  };
});
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "environment-1", connectionState: "connected" }],
  }),
}));

import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadKey,
} from "../lib/composerAttachmentUploadQueue";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import {
  composerAttachmentUploadsAtom,
  useComposerAttachmentUploadWorker,
} from "./composer-attachment-uploads";
import {
  enqueueThreadOutboxMessage,
  flushThreadOutbox,
  threadOutboxManager,
} from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import * as drafts from "./use-composer-drafts";
import { prepareQueuedMessageAttachments } from "./use-thread-outbox-drain";

const environmentId = EnvironmentId.make("environment-1");
const draftKey = "environment-1:thread-1";
const draftsUri = "file:///documents/composer-drafts/drafts.json";
const config = { environment: { capabilities: { attachmentUploads: true } } };
const image: DraftComposerAttachment = {
  id: "image-1",
  type: "image",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,YWJj",
  previewUri: "data:image/png;base64,YWJj",
};
let disposeWorker: (() => void) | undefined;

function worker() {
  native.effects = [];
  useComposerAttachmentUploadWorker();
  disposeWorker = native.effects[0]!() ?? undefined;
  const queue = native.queueRef.current!;
  native.effects[1]!();
  return queue;
}

function sendInput() {
  return {
    environmentId,
    attachments: drafts.getComposerDraftSnapshot(draftKey).attachments,
    connected: true,
    serverConfig: config,
    states: appAtomRegistry.get(composerAttachmentUploadsAtom),
  };
}

function queuedMessage(): QueuedThreadMessage {
  return {
    environmentId,
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
    text: "Look at this",
    attachments: drafts.getComposerDraftSnapshot(draftKey).attachments,
    createdAt: "2026-10-17T00:00:00.000Z",
  };
}

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  native.files.clear();
  native.server.clear();
  native.deleted.length = 0;
  native.fault = null;
  native.canOperate = true;
  native.nextId = 0;
  native.nextUuid = 0;
  native.files.set(draftsUri, Buffer.from('{"schemaVersion":1,"drafts":{}}'));
  drafts.resetComposerDraftsLoadState();
  appAtomRegistry.set(drafts.composerDraftsAtom, {
    [draftKey]: { text: "Look at this", attachments: [image] },
  });
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  await drafts.flushComposerDrafts();
  await threadOutboxManager.load();
  native.transfer.mockReset();
  native.transfer.mockImplementation(async (uri, url, options) => {
    const bytes = native.files.get(uri)!;
    options.onProgress?.({ bytesSent: bytes.length, totalBytes: bytes.length });
    native.server.set(url.split("/").at(-1)!, bytes);
    return { status: 204 };
  });
});

afterEach(async () => {
  disposeWorker?.();
  disposeWorker = undefined;
  native.fault = null;
  native.files.set(draftsUri, Buffer.from('{"schemaVersion":1,"drafts":{}}'));
  drafts.resetComposerDraftsLoadState();
  await drafts.flushComposerDrafts();
  await flushThreadOutbox();
  vi.restoreAllMocks();
});

function uploadState() {
  return appAtomRegistry.get(composerAttachmentUploadsAtom)[
    composerAttachmentUploadKey(environmentId, image.id)
  ];
}

it.each(["decode", "write"] as const)(
  "keeps an accepted upload ready when the draft %s fails",
  async (fault) => {
    native.fault = fault;
    if (fault === "decode")
      native.files.set(draftsUri, Buffer.from('{"schemaVersion":1,"drafts":'));
    drafts.resetComposerDraftsLoadState();
    const queue = worker();
    await queue.settled();
    expect(uploadState()).toEqual({ status: "ready" });
    expect(native.deleted).toEqual([]);
    expect(composerAttachmentUploadBlockReason(sendInput())).toBeNull();
    expect(composerAttachmentsStillUploading(sendInput())).toBe(false);

    const message = queuedMessage();
    expect(message.attachments[0]?.uploadedAttachmentId).toBe("pending-1");
    await enqueueThreadOutboxMessage(message);
    const prepared = await prepareQueuedMessageAttachments(message, true);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Outbox preparation abandoned");
    expect(prepared.prepared.pendingAttachmentIds).toEqual(["pending-1"]);
    expect(native.transfer).toHaveBeenCalledTimes(1);
  },
);

it.each(["http", "permission"] as const)(
  "keeps a real %s upload failure blocking Send",
  async (failure) => {
    if (failure === "http") native.transfer.mockResolvedValueOnce({ status: 503 });
    if (failure === "permission") native.canOperate = false;
    const queue = worker();
    await queue.settled();
    expect(composerAttachmentUploadBlockReason(sendInput())).toBe(
      "Retry or remove the failed attachment",
    );
    expect([...native.server.values()]).toEqual([]);
  },
);

it("keeps an unexpected draft flush error blocking Send", async () => {
  vi.spyOn(drafts, "flushComposerDrafts").mockRejectedValueOnce(
    new Error("Unexpected flush defect"),
  );
  const queue = worker();
  await queue.settled();
  expect(composerAttachmentUploadBlockReason(sendInput())).toBe(
    "Retry or remove the failed attachment",
  );
  expect(native.deleted).toEqual(["pending-1"]);
});

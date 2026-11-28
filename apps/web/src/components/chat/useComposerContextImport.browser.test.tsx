import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  makeThreadRequestsResolvedAnnouncer,
  type PendingThreadRequests,
} from "@t3tools/client-runtime/state/thread-requests";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import {
  type ComposerContextRecord,
  ComposerContextId,
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { rememberCopiedComposerAttachments } from "../../lib/copiedComposerAttachments";
import {
  questionAttachmentDraftId,
  countQuestionAttachments,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import { pendingDraftWork } from "./pendingDraftWork";
import { useComposerContextImport } from "./useComposerContextImport";

vi.mock("~/state/use-atom-query-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/use-atom-query-runner")>()),
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: { relativeUrl: "/file" } }),
}));
vi.mock("../../state/use-atom-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => () => {},
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readPreparedConnection: () => ({ httpBaseUrl: "http://localhost" }),
}));

type ImportInput = Parameters<typeof useComposerContextImport>[0];
type Importer = ReturnType<typeof useComposerContextImport>;

function Harness({ input, ready }: { input: ImportInput; ready: (value: Importer) => void }) {
  const importer = useComposerContextImport(input);
  useEffect(() => ready(importer));
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

it.each([
  { kind: "file", edit: "delete" },
  { kind: "image", edit: "delete" },
  { kind: "image", edit: "retain" },
  { kind: "file", edit: "undo" },
  { kind: "file", edit: "retain" },
  { kind: "file", edit: "switch" },
  { kind: "image", edit: "reload" },
  { kind: "file", edit: "cached" },
  { kind: "image", edit: "cached" },
  { kind: "file", edit: "question" },
  { kind: "image", edit: "question" },
  { kind: "image", edit: "question-switch" },
  { kind: "image", edit: "question-close" },
  { kind: "image", edit: "question-close-during-serialization" },
  { kind: "image", edit: "annotation" },
  { kind: "image", edit: "delete-annotation" },
] as const)("settles a delayed $kind import after $edit", async ({ kind, edit }) => {
  const isQuestion = edit.startsWith("question");
  const thread = scopeThreadRef(
    EnvironmentId.make("clipboard-target"),
    ThreadId.make(`clipboard-${kind}-${edit}`),
  );
  const requestId = RuntimeRequestId.make("request");
  const question = {
    id: "question",
    header: "Question",
    question: "What did you see?",
    options: [],
    multiSelect: false,
  };
  const request = {
    requestId,
    createdAt: "2026-01-01T00:00:00.000Z",
    questions: [question],
    responseCapability: "live",
    dismissible: false,
  } satisfies PendingThreadRequests["userInputs"][number];
  const requests = Atom.make<PendingThreadRequests | null>({
    approvals: [],
    userInputs: [request],
  });
  const target = isQuestion
    ? questionAttachmentDraftId(thread.environmentId, thread.threadId, requestId, question.id)
    : DraftId.make(`clipboard-${kind}-${edit}`);
  using _requests = vi
    .spyOn(environmentThreadDetails, "pendingRequestsAtom")
    .mockImplementation((ref) => {
      expect(ref).toEqual(thread);
      return requests;
    });
  const store = useComposerDraftStore.getState();
  using _draft = {
    [Symbol.dispose]: () => {
      store.clearComposerContent(target);
      store.clearComposerContent(thread);
    },
  };
  const sourceEnvironmentId = EnvironmentId.make("clipboard-source");
  rememberCopiedComposerAttachments(
    sourceEnvironmentId,
    edit === "cached"
      ? new Map([
          [
            "source-attachment",
            new File(["notes"], "notes.txt", {
              type: kind === "image" ? "image/png" : "text/plain",
            }),
          ],
        ])
      : new Map(),
  );
  using _copy = {
    [Symbol.dispose]: () => rememberCopiedComposerAttachments(sourceEnvironmentId, new Map()),
  };
  const downloaded = deferred<Response>();
  const requested = deferred<void>();
  const settled = deferred<void>();
  const input = {
    environmentId: thread.environmentId,
    linkedEnvironments: new Map(),
    activeThread: undefined,
    activeThreadId: isQuestion ? thread.threadId : null,
    composerDraftTarget: target,
    attachmentDraftTarget: target,
    attachmentTargetKey: target,
    questionAttachmentTarget: isQuestion ? target : null,
    pendingUserInputs: isQuestion ? [request] : [],
    composerContextRecords: new Map(),
    composerImages: [],
    pendingThreadImportsRef: { current: new Map() },
    addComposerFilesToDraft: (files: Parameters<typeof store.addFiles>[1]) =>
      store.addFiles(target, files, { appendReference: !isQuestion }),
  } satisfies ImportInput;
  let importer!: Importer;
  await using screen = await render(
    <Harness
      input={input}
      ready={(value) => {
        importer = value;
      }}
    />,
  );
  const end = pendingDraftWork.end.bind(pendingDraftWork);
  using _settled = vi.spyOn(pendingDraftWork, "end").mockImplementation((key) => {
    end(key);
    settled.resolve();
  });
  using _fetch = stubGlobal("fetch", () => {
    requested.resolve();
    return downloaded.promise;
  });
  const pauseSerialization =
    edit === "question-switch" || edit === "question-close-during-serialization";
  const serializing = deferred<void>();
  const resumeSerialization = deferred<void>();
  const readAsDataURL = FileReader.prototype.readAsDataURL;
  using reader = vi.spyOn(FileReader.prototype, "readAsDataURL");
  if (pauseSerialization) {
    reader.mockImplementation(function (this: FileReader, blob) {
      serializing.resolve();
      void resumeSerialization.promise.then(() => readAsDataURL.call(this, blob));
    });
  }
  const contextId = ComposerContextId.make(`${kind}_source`);
  const attachmentFields = {
    version: 1 as const,
    contextId,
    label: "notes.txt",
    attachmentId: "source-attachment",
    name: "notes.txt",
    mimeType: kind === "file" ? "text/plain" : "image/png",
    sizeBytes: 5,
  };
  const attachment = (
    kind === "file"
      ? { ...attachmentFields, kind: "file" as const }
      : {
          ...attachmentFields,
          kind: "image" as const,
          source: {
            kind: "snap-shot" as const,
            appName: "Finder",
            windowTitle: "Downloads",
            capturedAt: "2026-01-01T00:00:00.000Z",
            accessibleText: "Downloads",
          },
        }
  ) satisfies ComposerContextRecord;
  const annotation = {
    version: 1,
    kind: "preview-annotation",
    contextId: ComposerContextId.make("preview-annotation_source"),
    label: "Page annotation",
    annotationId: "source",
    pageUrl: "http://localhost/page",
    pageTitle: "Page",
    comment: "Check this",
    targetSummary: "Page",
    styleChanges: [],
    screenshotContextId: contextId,
  } satisfies ComposerContextRecord;
  const annotated = edit === "annotation" || edit === "delete-annotation";
  let pastedPrompt = "";
  await act(async () => {
    const remapped = importer.importContextRecords(
      annotated ? [attachment, annotation] : [attachment],
      sourceEnvironmentId,
    );
    pastedPrompt = formatInlineContextReference({
      kind: annotated ? "preview-annotation" : kind,
      contextId: remapped.get(annotated ? annotation.contextId : contextId)!,
      label: annotated ? "Page annotation" : "notes.txt",
    });
    if (isQuestion) pastedPrompt = "Question answer";
    store.setPrompt(target, pastedPrompt);
    if (edit !== "cached") await requested.promise;
  });
  if (edit !== "cached") expect(pendingDraftWork.has(target)).toBe(true);
  await act(() => {
    if (edit === "delete" || edit === "delete-annotation" || edit === "undo") {
      store.setPrompt(target, "Keep this edit");
    }
    if (edit === "undo") {
      store.setPrompt(target, pastedPrompt);
    }
  });
  if (edit === "switch" || edit === "reload" || pauseSerialization) {
    await screen.unmount();
  }
  const closeQuestion = () => {
    appAtomRegistry.set(requests, { approvals: [], userInputs: [] });
    const announce = makeThreadRequestsResolvedAnnouncer(thread.environmentId, thread.threadId);
    announce([{ id: requestId, status: "pending" }]);
    announce([{ id: requestId, status: "cancelled" }]);
  };
  if (edit === "question-close") closeQuestion();
  let slotsDuringSerialization: number | undefined;
  await act(async () => {
    downloaded.resolve(new Response("notes", { headers: { "Content-Type": attachment.mimeType } }));
    if (pauseSerialization) {
      await serializing.promise;
      slotsDuringSerialization = countQuestionAttachments([target]);
      if (edit === "question-close-during-serialization") closeQuestion();
      resumeSerialization.resolve();
    }
    await settled.promise;
  });
  expect(pendingDraftWork.has(target)).toBe(false);
  if (
    kind === "image" &&
    (edit === "delete" || edit === "delete-annotation" || edit === "question-close")
  ) {
    expect(reader).not.toHaveBeenCalled();
  }
  if (pauseSerialization) expect(slotsDuringSerialization).toBe(1);
  if (isQuestion) expect(useQuestionAttachmentPreparation.getState().counts[target] ?? 0).toBe(0);
  if (edit === "reload") {
    const inMemoryFile = store.getComposerDraft(target)?.images[0]?.file;
    await useComposerDraftStore.persist.rehydrate();
    const restored = store.getComposerDraft(target)?.images[0]?.file;
    expect(restored).not.toBe(inMemoryFile);
    expect(await restored?.text()).toBe("notes");
  }
  if (edit === "question-close" || edit === "question-close-during-serialization") {
    expect(store.getComposerDraft(target)).toBeNull();
    expect(store.getComposerDraft(thread)?.images ?? []).toEqual([]);
    return;
  }
  const draft = store.getComposerDraft(target)!;
  expect(draft.prompt).toBe(
    edit === "delete" || edit === "delete-annotation" ? "Keep this edit" : pastedPrompt,
  );
  const attachments = kind === "file" ? draft.files : draft.images;
  if (kind === "image" && edit === "retain")
    expect(draft.images[0]?.source).toEqual(
      attachment.kind === "image" ? attachment.source : undefined,
    );
  expect(attachments.map((file) => file.name)).toEqual(
    edit === "undo" ||
      edit === "retain" ||
      edit === "switch" ||
      edit === "reload" ||
      edit === "annotation" ||
      edit === "cached" ||
      isQuestion
      ? ["notes.txt"]
      : [],
  );
});

it.each(["same", "other-environment"] as const)(
  "preserves thread identity across repeated pastes: %s",
  async (variant) => {
    const otherEnvironment = variant === "other-environment";
    const target = DraftId.make(`thread-collision-${variant}`);
    const store = useComposerDraftStore.getState();
    using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
    const environmentId = EnvironmentId.make("thread-source");
    const otherEnvironmentId = EnvironmentId.make("other-thread-source");
    const first = threadContextRecord(
      { environmentId, threadId: ThreadId.make("same-id") },
      "First",
    );
    const pasted = otherEnvironment
      ? threadContextRecord(
          { environmentId: otherEnvironmentId, threadId: first.threadId },
          "Second",
        )
      : first;
    store.addThreadContexts(target, [first], { appendReference: false });
    let importer!: Importer;
    await using _screen = await render(
      <Harness
        input={{
          environmentId,
          linkedEnvironments: new Map([[otherEnvironmentId, "Other machine"]]),
          activeThread: undefined,
          activeThreadId: null,
          composerDraftTarget: target,
          attachmentDraftTarget: target,
          attachmentTargetKey: target,
          questionAttachmentTarget: null,
          pendingUserInputs: [],
          composerContextRecords: new Map([[first.contextId, { kind: "thread", record: first }]]),
          composerImages: [],
          pendingThreadImportsRef: { current: new Map() },
          addComposerFilesToDraft: () => [],
        }}
        ready={(value) => {
          importer = value;
        }}
      />,
    );
    let importedId: string | undefined;
    await act(() => {
      importedId = importer
        .importContextRecords([pasted], pasted.environmentId, target)
        .get(pasted.contextId);
    });
    const records = store.getComposerDraft(target)!.threadContexts;
    expect(records.find((record) => record.contextId === importedId)).toMatchObject({
      environmentId: pasted.environmentId,
      threadId: pasted.threadId,
    });
    expect(records).toHaveLength(otherEnvironment ? 2 : 1);
    expect(records[0]).toEqual(first);
    await act(() => {
      const repeated = importer.importContextRecords([pasted], pasted.environmentId, target);
      expect(repeated.get(pasted.contextId)).toBe(importedId);
    });
    expect(store.getComposerDraft(target)!.threadContexts).toEqual(records);
  },
);

import { useEffect } from "react";
import {
  type ComposerContextRecord,
  ComposerContextId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { rememberCopiedComposerAttachments } from "../../lib/copiedComposerAttachments";
import { importPastedComposerText } from "../composerInlineTokenPaste";
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

function importInput(target: DraftId, promptRef: { current: string }) {
  const store = useComposerDraftStore.getState();
  return {
    environmentId: EnvironmentId.make("clipboard-target"),
    activeThread: undefined,
    activeThreadId: null,
    composerDraftTarget: target,
    attachmentDraftTarget: target,
    attachmentTargetKey: target,
    attachmentTargetKeyRef: { current: target },
    questionAttachmentTarget: null,
    pendingUserInputs: [],
    composerContextRecords: new Map(),
    composerImages: [],
    composerFilesRef: { current: [] },
    pendingThreadImportsRef: { current: new Map() },
    promptRef,
    addComposerFilesToDraft: (files: Parameters<typeof store.addFiles>[1]) =>
      store.addFiles(target, files),
  } satisfies ImportInput;
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
  { kind: "file", edit: "undo" },
  { kind: "file", edit: "retain" },
  { kind: "file", edit: "switch" },
  { kind: "file", edit: "cached" },
  { kind: "file", edit: "question" },
  { kind: "image", edit: "question" },
  { kind: "image", edit: "annotation" },
  { kind: "image", edit: "delete-annotation" },
  // Copying a pending chip carries no record; pasting it over itself must keep its link.
  { kind: "file", edit: "repaste" },
] as const)("settles a delayed $kind import after $edit", async ({ kind, edit }) => {
  const target = DraftId.make(`clipboard-${kind}-${edit}`);
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const sourceEnvironmentId = EnvironmentId.make("clipboard-source");
  rememberCopiedComposerAttachments(
    sourceEnvironmentId,
    edit === "cached"
      ? new Map([["source-attachment", new File(["notes"], "notes.txt")]])
      : new Map(),
  );
  using _copy = {
    [Symbol.dispose]: () => rememberCopiedComposerAttachments(sourceEnvironmentId, new Map()),
  };
  const promptRef = { current: "" };
  const downloaded = deferred<Response>();
  const requested = deferred<void>();
  const settled = deferred<void>();
  const input = {
    ...importInput(target, promptRef),
    questionAttachmentTarget: edit === "question" ? target : null,
    addComposerFilesToDraft: (files: Parameters<typeof store.addFiles>[1]) =>
      store.addFiles(target, files, { appendReference: edit !== "question" }),
  } satisfies ImportInput;
  let importer!: Importer;
  await using _screen = await render(
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
      : { ...attachmentFields, kind: "image" as const }
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
    if (edit === "question") pastedPrompt = "Question answer";
    promptRef.current = pastedPrompt;
    store.setPrompt(target, pastedPrompt);
    if (edit !== "cached") await requested.promise;
  });
  if (edit !== "cached") expect(pendingDraftWork.has(target)).toBe(true);
  await act(() => {
    if (edit === "repaste") {
      promptRef.current = importPastedComposerText(
        { getData: (format) => (format === "text/plain" ? pastedPrompt : "") },
        importer.importContextFragment,
        importer.importingContextIdsRef.current,
      );
      store.setPrompt(target, promptRef.current);
    }
    if (
      edit !== "annotation" &&
      edit !== "retain" &&
      edit !== "cached" &&
      edit !== "question" &&
      edit !== "switch" &&
      edit !== "repaste"
    ) {
      promptRef.current = "Keep this edit";
      store.setPrompt(target, promptRef.current);
    }
    if (edit === "undo") {
      promptRef.current = pastedPrompt;
      store.setPrompt(target, pastedPrompt);
    }
    if (edit === "switch") input.attachmentTargetKeyRef.current = DraftId.make("other-draft");
  });
  await act(async () => {
    downloaded.resolve(new Response("notes", { headers: { "Content-Type": attachment.mimeType } }));
    await settled.promise;
  });
  expect(pendingDraftWork.has(target)).toBe(false);
  const draft = store.getComposerDraft(target)!;
  expect(draft.prompt).toBe(promptRef.current);
  const attachments = kind === "file" ? draft.files : draft.images;
  expect(attachments.map((file) => file.name)).toEqual(
    edit === "undo" ||
      edit === "retain" ||
      edit === "repaste" ||
      edit === "annotation" ||
      edit === "cached" ||
      edit === "question"
      ? ["notes.txt"]
      : [],
  );
});

// Dropping it left the pasted chip resolving to nothing, so the agent saw an unavailable thread.
it("keeps a pasted thread from a machine this one does not link to", async () => {
  const target = DraftId.make("clipboard-unlinked-thread");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
  const record = threadContextRecord(
    { environmentId: EnvironmentId.make("unlinked-machine"), threadId: ThreadId.make("remote") },
    "Remote thread",
  );
  let importer!: Importer;
  await using _screen = await render(
    <Harness
      input={importInput(target, { current: "" })}
      ready={(value) => {
        importer = value;
      }}
    />,
  );
  let rewritten = new Map<string, string>();
  await act(() => {
    rewritten = new Map(importer.importContextRecords([record], record.environmentId));
  });
  expect(rewritten.get(record.contextId)).toBe(record.contextId);
  expect(store.getComposerDraft(target)?.threadContexts).toEqual([record]);
});

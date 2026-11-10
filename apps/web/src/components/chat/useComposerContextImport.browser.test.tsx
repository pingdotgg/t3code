import { useEffect } from "react";
import {
  type ComposerContextRecord,
  ComposerContextId,
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { hostedThreadLink } from "@t3tools/shared/threadLinks";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
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
  readPreparedConnection: (environmentId: string) =>
    environmentId === "disconnected-machine" ? null : { httpBaseUrl: "http://localhost" },
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
    linkedEnvironments: new Map(),
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
    importThreadTranscript: () => {},
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
  // The download outlives the composer that started it, so a remounted one must see it.
  { kind: "file", edit: "remount-repaste" },
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
  const harness = (key: string) => (
    <Harness
      key={key}
      input={input}
      ready={(value) => {
        importer = value;
      }}
    />
  );
  await using screen = await render(harness("first"));
  const end = pendingDraftWork.end.bind(pendingDraftWork);
  using _settled = vi.spyOn(pendingDraftWork, "end").mockImplementation((...args) => {
    end(...args);
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
  if (edit === "remount-repaste") await screen.rerender(harness("second"));
  await act(() => {
    if (edit === "repaste" || edit === "remount-repaste") {
      promptRef.current = importPastedComposerText(
        { getData: (format) => (format === "text/plain" ? pastedPrompt : "") },
        importer.importContextFragment,
        pendingDraftWork.importingContextIds(target),
      );
      store.setPrompt(target, promptRef.current);
    }
    if (
      edit !== "annotation" &&
      edit !== "retain" &&
      edit !== "cached" &&
      edit !== "question" &&
      edit !== "switch" &&
      edit !== "repaste" &&
      edit !== "remount-repaste"
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
      edit === "remount-repaste" ||
      edit === "annotation" ||
      edit === "cached" ||
      edit === "question"
      ? ["notes.txt"]
      : [],
  );
});

// Its chip used to resolve to nothing; now it keeps a link naming the thread and its machine.
it.each([
  { machine: "unlinked-machine", transcript: true },
  // Nothing can load a machine this client is not connected to, so only the link remains.
  { machine: "disconnected-machine", transcript: false },
])(
  "pastes a thread from $machine, importing its transcript: $transcript",
  async ({ machine, transcript }) => {
    const target = DraftId.make(`clipboard-${machine}-thread`);
    const store = useComposerDraftStore.getState();
    using _draft = { [Symbol.dispose]: () => store.clearComposerContent(target) };
    const ref = {
      environmentId: EnvironmentId.make(machine),
      threadId: ThreadId.make("remote"),
    };
    const record = threadContextRecord(ref, "Remote thread");
    const importThreadTranscript = vi.fn();
    let importer!: Importer;
    await using _screen = await render(
      <Harness
        input={{ ...importInput(target, { current: "" }), importThreadTranscript }}
        ready={(value) => {
          importer = value;
        }}
      />,
    );
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: ref.environmentId },
      records: [record],
    })!;
    let pasted = "";
    await act(() => {
      pasted = importPastedComposerText(
        {
          getData: (format) =>
            format === "text/plain"
              ? `See ${formatInlineContextReference(threadContextReference(record))}`
              : format === COMPOSER_CONTEXT_CLIPBOARD_MIME
                ? fragment
                : "",
        },
        importer.importContextFragment,
      );
    });
    expect(pasted).toBe(`See [Remote thread](${hostedThreadLink(ref, configuredHostedAppUrl())})`);
    expect(importThreadTranscript.mock.calls).toEqual(transcript ? [[ref, target]] : []);
    expect(store.getComposerDraft(target)?.threadContexts ?? []).toEqual([]);
  },
);

it("points a pasted duplicate at the id the draft holds it under", async () => {
  const target = DraftId.make("clipboard-alias-duplicate");
  const held = threadContextRecord(
    { environmentId: EnvironmentId.make("clipboard-target"), threadId: ThreadId.make("alias") },
    "Alias thread",
  );
  const pasted = { ...held, contextId: ComposerContextId.make("alias") };
  let importer!: Importer;
  await using _screen = await render(
    <Harness
      input={{
        ...importInput(target, { current: "" }),
        composerContextRecords: new Map([[held.contextId, { kind: "thread", record: held }]]),
      }}
      ready={(value) => {
        importer = value;
      }}
    />,
  );
  expect(importer.importContextRecords([pasted], null).get("alias")).toBe(held.contextId);
});

// A stash restores into the prompt behind an open question, not into the question's answer.
it("imports a restored thread's transcript into the draft the restore names", async () => {
  const target = DraftId.make("stash-unlinked-thread");
  const question = DraftId.make("stash-unlinked-thread-question");
  const ref = {
    environmentId: EnvironmentId.make("unlinked-machine"),
    threadId: ThreadId.make("remote"),
  };
  const importThreadTranscript = vi.fn();
  let importer!: Importer;
  await using _screen = await render(
    <Harness
      input={{
        ...importInput(question, { current: "" }),
        composerDraftTarget: target,
        questionAttachmentTarget: question,
        importThreadTranscript,
      }}
      ready={(value) => {
        importer = value;
      }}
    />,
  );
  const rewritten = importer.importContextRecords(
    [threadContextRecord(ref, "Remote thread")],
    null,
    target,
  );
  expect([...rewritten.values()]).toEqual([null]);
  expect(importThreadTranscript).toHaveBeenCalledWith(ref, target);
});

it("counts the attachments of the draft a restore names, not the open question's", async () => {
  const target = DraftId.make("stash-limit-target");
  const question = DraftId.make("stash-limit-question");
  const store = useComposerDraftStore.getState();
  using _draft = { [Symbol.dispose]: () => store.clearComposerContent(question) };
  store.addFiles(
    question,
    Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => {
      const file = new File([`${index}`], `answer-${index}.txt`, { type: "text/plain" });
      return {
        type: "file" as const,
        id: `answer-${index}`,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
    }),
  );
  let importer!: Importer;
  await using _screen = await render(
    <Harness
      input={{
        ...importInput(question, { current: "" }),
        composerDraftTarget: target,
        questionAttachmentTarget: question,
      }}
      ready={(value) => {
        importer = value;
      }}
    />,
  );
  expect(importer.countReservedAttachments()).toBe(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  expect(importer.countReservedAttachments(target)).toBe(0);
});

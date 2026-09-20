import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker } from "./TraitsPicker";
import { ComposerSurface } from "./ComposerSurface";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerFooterModeControls } from "./ChatComposer";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  startAttachmentUpload,
  releaseAttachmentUpload,
  getUploadedAttachments,
  useAttachmentUploadStore,
  retryAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { attachmentUploadBlockReason } from "../../lib/attachmentUploadState";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "./composerAttachmentFiles";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { type ThreadId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { SIDE_MESSAGE_PREFIX } from "@t3tools/shared/sideChat";
import * as Cause from "effect/Cause";
import { CornerUpLeftIcon, CheckIcon, XIcon, PaperclipIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { newMessageId, randomUUID } from "../../lib/utils";
import { useThread } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

const release = (file: ComposerImageAttachment | ComposerFileAttachment) => {
  releaseAttachmentUpload(file.id);
  if (file.type === "image") URL.revokeObjectURL(file.previewUrl);
};

export function SideChatSession({
  source,
  cwd,
  threadId,
  prompt,
  active,
  settings,
  instanceEntries,
}: {
  source: EnvironmentThread;
  cwd: string | undefined;
  threadId: ThreadId;
  prompt: string;
  active: boolean;
  settings: UnifiedSettings;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const environmentId = source.environmentId;
  const threadRef = useMemo(
    () => (threadId ? { environmentId, threadId } : null),
    [environmentId, threadId],
  );
  const thread = useThread(threadRef, { waitForShell: true });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const approve = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const answer = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(prompt);
  const [pending, setPending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const submitting = useRef(false);
  const [answers, setAnswers] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});

  const [selection, setSelection] = useState<ModelSelection>(source.modelSelection);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(source.runtimeMode);
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
  const initializedSettings = useRef(false);
  useEffect(() => {
    if (!thread || initializedSettings.current) return;
    initializedSettings.current = true;
    setSelection(thread.modelSelection);
    setRuntimeMode(thread.runtimeMode);
    setInteractionMode(thread.interactionMode);
  }, [thread]);
  const entry = instanceEntries.find((item) => item.instanceId === selection.instanceId);
  const models = useMemo(
    () =>
      new Map(
        instanceEntries.map((item) => [
          item.instanceId,
          getAppModelOptionsForInstance(
            settings,
            item,
            item.instanceId === selection.instanceId ? selection.model : null,
          ),
        ]),
      ),
    [instanceEntries, settings, selection.instanceId, selection.model],
  );
  const [files, setFiles] = useState<Array<ComposerImageAttachment | ComposerFileAttachment>>([]);
  const filesRef = useRef(files);
  useLayoutEffect(() => {
    filesRef.current = files;
  }, [files]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const alive = useRef(true);
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const uploadError = attachmentUploadBlockReason({
    imageIds: files.map((file) => file.id),
    uploadsByImageId: uploads,
    environmentId,
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const file of filesRef.current) release(file);
    };
  }, []);
  const attach = async (incoming: File[]) => {
    if (preparingRef.current || submitting.current) return;
    preparingRef.current = true;
    setPreparing(true);
    setError(null);
    const added: Array<ComposerImageAttachment | ComposerFileAttachment> = [];
    try {
      for (let file of incoming) {
        if (filesRef.current.length + added.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
          throw new Error("Too many attachments.");
        const kind = classifyComposerAttachmentFile(file);
        if (kind === "unsupported-image") throw new Error(`Unsupported image: ${file.name}`);
        if (kind === "image") {
          const prepared = await prepareImageForAttachment(
            normalizeComposerImageFileMimeType(file),
            PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
          );
          if (!prepared.ok) throw new Error(`Cannot prepare image: ${file.name}`);
          file = prepared.file;
          added.push({
            type: "image",
            id: randomUUID(),
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
            previewUrl: URL.createObjectURL(file),
          });
        } else {
          if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
            throw new Error(`File is too large: ${file.name}`);
          added.push({
            type: "file",
            id: randomUUID(),
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            file,
          });
        }
      }
    } catch (error) {
      if (alive.current) setError(String(error));
    } finally {
      if (alive.current) {
        for (const file of added) startAttachmentUpload({ environmentId, image: file });
        setFiles((current) => [...current, ...added]);
        setPreparing(false);
      } else {
        for (const file of added) release(file);
      }
      preparingRef.current = false;
    }
  };

  useEffect(() => {
    if (active) textarea.current?.focus();
  }, [active]);

  const messages =
    thread?.messages.filter((message) => !message.id.startsWith(SIDE_MESSAGE_PREFIX)) ?? [];
  const requests = derivePendingRequests(thread?.activities ?? []);
  const running =
    thread?.session?.status === "running" ||
    thread?.session?.status === "starting" ||
    thread?.latestTurn?.state === "running";
  useEffect(() => {
    if (followOutput.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [thread?.messages, thread?.activities]);

  const act = useCallback(async (operation: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (submitting.current) return false;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await operation();
      if (result._tag === "Failure") {
        setError(String(Cause.squash(result.cause)));
        return false;
      }
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (
      !thread ||
      (!text && !files.length) ||
      preparing ||
      uploadError ||
      running ||
      requests.approvals.length ||
      requests.userInputs.length
    )
      return;
    const attachments = getUploadedAttachments({ environmentId, images: files });
    if (!attachments) return;
    const ok = await act(() =>
      start({
        environmentId,
        input: {
          threadId: thread.id,
          message: { messageId: newMessageId(), role: "user", text, attachments },
          modelSelection: selection,
          runtimeMode,
          interactionMode,
          createdAt: new Date().toISOString(),
        },
      }),
    );
    if (ok) {
      setDraft("");
      for (const file of filesRef.current) release(file);
      filesRef.current = [];
      setFiles([]);
      followOutput.current = true;
      if (active) textarea.current?.focus();
    }
  };
  const [sentToMain, setSentToMain] = useState<Set<string>>(() => new Set());
  const sendToMain = async (messageId: string, text: string) => {
    const ok = await act(() =>
      start({
        environmentId,
        input: {
          threadId: source.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: `Continue with this input from my side chat:\n\n${text}`,
            attachments: [],
          },
          modelSelection: source.modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          createdAt: new Date().toISOString(),
        },
      }),
    );
    if (ok) setSentToMain((current) => new Set([...current, messageId]));
  };
  const respond = (
    requestId: Parameters<typeof approve>[0]["input"]["requestId"],
    decision: ProviderApprovalDecision,
  ) =>
    threadId &&
    void act(() => approve({ environmentId, input: { threadId, requestId, decision } }));

  return (
    <section data-side-chat className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el) followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {!messages.length && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Ask about anything in the main conversation so far.
            <br />
          </p>
        )}
        {thread && (
          <p className="mb-4 text-xs text-muted-foreground">
            Snapshot of main chat · Later messages aren’t included
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className="mb-5 min-w-0">
            <div
              className={
                message.role === "user"
                  ? "ml-auto w-fit max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
                  : "min-w-0"
              }
            >
              {message.attachments?.map((attachment) => (
                <p
                  key={attachment.id}
                  className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"
                >
                  <PaperclipIcon className="size-3" />
                  {attachment.name}
                </p>
              ))}
              {message.role === "user" ? (
                <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
              ) : (
                <ChatMarkdown
                  text={message.text}
                  cwd={cwd}
                  threadRef={threadRef ?? undefined}
                  environmentId={environmentId}
                  isStreaming={message.streaming}
                />
              )}
            </div>
            {message.role === "assistant" && !message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      className="mt-1 gap-1.5 text-muted-foreground"
                      aria-label={
                        sentToMain.has(message.id) ? "Sent to Main Chat" : "Send to Main Chat"
                      }
                      disabled={pending || sentToMain.has(message.id)}
                      onClick={() => void sendToMain(message.id, message.text)}
                    >
                      {sentToMain.has(message.id) ? (
                        <CheckIcon className="size-3.5" />
                      ) : (
                        <CornerUpLeftIcon className="size-3.5" />
                      )}
                      {sentToMain.has(message.id) ? "Sent to main chat" : "Send to main chat"}
                    </Button>
                  }
                />
                <TooltipPopup>
                  {sentToMain.has(message.id) ? "Sent to Main Chat" : "Send to Main Chat"}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ))}
        {running && <p className="text-xs text-muted-foreground">Working…</p>}
        {requests.approvals.map((approval) => (
          <div
            key={approval.requestId}
            className="my-3 rounded-lg border border-border p-3 text-sm"
          >
            <p>{approval.detail ?? `Permission requested: ${approval.requestKind}`}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(
                approval.options ?? [
                  { decision: "accept" as const, label: "Allow once" },
                  { decision: "decline" as const, label: "Decline" },
                ]
              ).map((option) => (
                <Button
                  key={option.decision}
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={option.warning ? `${option.label}: ${option.warning}` : option.label}
                  onClick={() => respond(approval.requestId, option.decision)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
        {requests.userInputs.map((input) => {
          const drafts = answers[input.requestId] ?? {};
          const resolved = buildPendingUserInputAnswers(input.questions, drafts);
          return (
            <form
              key={input.requestId}
              className="my-3 space-y-3 rounded-lg border border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (threadId && resolved)
                  void act(() =>
                    answer({
                      environmentId,
                      input: { threadId, requestId: input.requestId, answers: resolved },
                    }),
                  );
              }}
            >
              {input.questions.map((question) => (
                <fieldset key={question.id} className="text-sm">
                  <legend>{question.question}</legend>
                  {question.options.map((option) => {
                    const value = option.value ?? option.label;
                    const selected =
                      drafts[question.id]?.selectedOptionValues?.includes(value) ?? false;
                    return (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={selected}
                        aria-label={
                          option.description
                            ? `${option.label}: ${option.description}`
                            : option.label
                        }
                        className={`mt-2 block rounded border px-2 py-1 text-left text-xs ${selected ? "border-primary bg-primary/10" : "border-border"}`}
                        onClick={() =>
                          setAnswers((current) => ({
                            ...current,
                            [input.requestId]: {
                              ...current[input.requestId],
                              [question.id]: togglePendingUserInputOptionSelection(
                                question,
                                current[input.requestId]?.[question.id],
                                value,
                              ),
                            },
                          }))
                        }
                      >
                        {option.label}
                      </button>
                    );
                  })}
                  {question.allowCustomAnswer !== false && (
                    <input
                      aria-label={question.header || question.question}
                      placeholder="Your answer…"
                      className="mt-2 w-full rounded border border-border bg-transparent p-2 text-sm"
                      value={drafts[question.id]?.customAnswer ?? ""}
                      onChange={(event) =>
                        setAnswers((current) => ({
                          ...current,
                          [input.requestId]: {
                            ...current[input.requestId],
                            [question.id]: setPendingUserInputCustomAnswer(
                              current[input.requestId]?.[question.id],
                              event.target.value,
                            ),
                          },
                        }))
                      }
                    />
                  )}
                </fieldset>
              ))}
              <Button type="submit" size="sm" disabled={pending || !resolved}>
                Reply
              </Button>
            </form>
          );
        })}
      </div>
      {(error || thread?.session?.lastError) && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {error ?? thread?.session?.lastError}
        </p>
      )}
      <div className="shrink-0 px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-1.5 sm:px-5 sm:pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:pt-2">
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <form
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onDrop={(event) => {
                if (event.dataTransfer.files.length) {
                  event.preventDefault();
                  event.stopPropagation();
                  void attach(Array.from(event.dataTransfer.files));
                }
              }}
              onPaste={(event) => {
                if (event.clipboardData.files.length) {
                  event.preventDefault();
                  event.stopPropagation();
                  void attach(Array.from(event.clipboardData.files));
                }
              }}
              className="relative"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <ComposerSurface.Main>
                <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    aria-label="Attach files to side chat"
                    onChange={(event) => {
                      void attach(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                  {files.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {files.map((file) => (
                        <div
                          key={file.id}
                          className="flex max-w-full items-center gap-2 rounded-lg border border-border p-2 text-xs"
                        >
                          {file.type === "image" && (
                            <img
                              src={file.previewUrl}
                              alt={file.name}
                              className="size-10 rounded object-cover"
                            />
                          )}
                          <span className="min-w-0 truncate">{file.name}</span>
                          {uploads[file.id]?.status === "uploading" && <span>Uploading…</span>}
                          {uploads[file.id]?.status === "failed" && (
                            <button
                              type="button"
                              onClick={() => retryAttachmentUpload({ environmentId, image: file })}
                            >
                              Retry upload
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={pending}
                            aria-label={`Remove ${file.name}`}
                            onClick={() => {
                              release(file);
                              setFiles((current) => current.filter((item) => item.id !== file.id));
                            }}
                          >
                            <XIcon className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textarea}
                    aria-label="Message side chat"
                    placeholder="Ask a side question…"
                    rows={3}
                    className="block max-h-50 min-h-17.5 w-full resize-none overflow-y-auto bg-transparent leading-relaxed text-foreground outline-none placeholder:text-placeholder/75 [field-sizing:content] [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)] [@media(max-width:39.999rem)_and_(pointer:coarse)]:[font-size:max(var(--font-size-prompt,1rem),16px)]"
                    value={draft}
                    disabled={pending}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  {uploadError && (
                    <p role="status" className="mb-2 text-xs text-muted-foreground">
                      {uploadError}
                    </p>
                  )}
                </div>
                <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:gap-0 sm:px-4 sm:pb-4">
                  <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <ProviderModelPicker
                      activeInstanceId={selection.instanceId}
                      model={selection.model}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={models}
                      lockedProvider={thread?.session ? (entry?.driverKind ?? null) : null}
                      disabled={!thread || pending || running}
                      triggerAriaLabel="Side chat model"
                      onInstanceModelChange={(instanceId, model) =>
                        setSelection({ instanceId, model })
                      }
                    />
                    {entry && (
                      <TraitsPicker
                        provider={entry.driverKind}
                        instanceId={entry.instanceId}
                        model={selection.model}
                        models={entry.models}
                        modelOptions={selection.options}
                        prompt={draft}
                        onPromptChange={setDraft}
                        planModeEnabled={settings.planModeEnabled}
                        onModelOptionsChange={(options) =>
                          setSelection((current) => ({ ...current, options: options ?? [] }))
                        }
                      />
                    )}
                    <ComposerFooterModeControls
                      runtimeMode={runtimeMode}
                      interactionMode={interactionMode}
                      showInteractionModeToggle={settings.planModeEnabled}
                      onRuntimeModeChange={setRuntimeMode}
                      onToggleInteractionMode={() =>
                        setInteractionMode((current) => (current === "plan" ? "default" : "plan"))
                      }
                    />
                  </div>
                  <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Attach to side chat"
                      disabled={preparing || pending}
                      onClick={() => fileInput.current?.click()}
                    >
                      <PaperclipIcon className="size-4" />
                    </Button>
                    <ComposerPrimaryActions
                      compact={false}
                      pendingAction={null}
                      isRunning={!!running}
                      showPlanFollowUpPrompt={false}
                      promptHasText={!!draft.trim()}
                      isSendBusy={pending}
                      sendDisabledReason={
                        uploadError ||
                        (preparing ? "Preparing attachment" : null) ||
                        (requests.approvals.length || requests.userInputs.length
                          ? "Reply to the pending request"
                          : null)
                      }
                      isConnecting={!thread}
                      isEnvironmentUnavailable={false}
                      isPreparingWorktree={false}
                      hasSendableContent={!!draft.trim() || files.length > 0}
                      onPreviousPendingQuestion={() => undefined}
                      onInterrupt={() => {
                        void act(() => interrupt({ environmentId, input: { threadId } }));
                      }}
                      onImplementPlanInNewThread={() => undefined}
                    />
                  </div>
                </div>
              </ComposerSurface.Main>
            </form>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </section>
  );
}

import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  AuthOrchestrationOperateScope,
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
import { TraitsPicker, readPromptUltrathink } from "./TraitsPicker";
import { SecretRequestCard } from "./SecretRequestCard";
import { SideChatControls } from "./SideChatControls";
import { ComposerSurface } from "./ComposerSurface";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerFooterModeControls } from "./ComposerFooterControls";
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
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { type ThreadId, type ProviderApprovalDecision } from "@t3tools/contracts";

import * as Cause from "effect/Cause";
import { XIcon, PaperclipIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { newMessageId, randomUUID } from "../../lib/utils";
import { useThreadShell, useThreadProjection, resolveThreadDetailRef } from "../../state/entities";
import { deriveThreadRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

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
  source: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "modelSelection" | "runtimeMode" | "interactionMode"
  >;
  cwd: string | undefined;
  threadId: ThreadId;
  prompt: string;
  active: boolean;
  settings: UnifiedSettings;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const environmentId = source.environmentId;
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const threadRef = threadId ? { environmentId, threadId } : null;
  const shell = useThreadShell(threadRef);
  const thread = useThreadProjection(
    resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true }),
  )?.projection;
  const runtime = thread ? deriveThreadRuntime(thread) : null;
  const start = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interrupt = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const approve = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const answer = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
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
    setSelection(thread.thread.modelSelection);
    setRuntimeMode(thread.thread.runtimeMode);
    setInteractionMode(thread.thread.interactionMode);
  }, [thread]);
  const entry = instanceEntries.find((item) => item.instanceId === selection.instanceId);
  const models = new Map(
    instanceEntries.map((item) => [
      item.instanceId,
      getAppModelOptionsForInstance(
        settings,
        item,
        item.instanceId === selection.instanceId ? selection.model : null,
      ),
    ]),
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
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      preparingRef.current ||
      submitting.current
    )
      return;
    preparingRef.current = true;
    setPreparing(true);
    setError(null);
    const added: Array<ComposerImageAttachment | ComposerFileAttachment> = [];
    let attachmentError: string | null = null;
    try {
      for (let file of incoming) {
        if (filesRef.current.length + added.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          attachmentError = "Too many attachments.";
          break;
        }
        const kind = classifyComposerAttachmentFile(file);
        if (kind === "unsupported-image") {
          attachmentError = `Unsupported image: ${file.name}`;
          break;
        }
        if (kind === "image") {
          const prepared = await prepareImageForAttachment(
            normalizeComposerImageFileMimeType(file),
            PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
          );
          if (!prepared.ok) {
            attachmentError = `Cannot prepare image: ${file.name}`;
            break;
          }
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
          if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
            attachmentError = `File is too large: ${file.name}`;
            break;
          }
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
      attachmentError = String(error);
    }
    if (alive.current) {
      setError(attachmentError);
      for (const file of added) startAttachmentUpload({ environmentId, image: file });
      setFiles((current) => [...current, ...added]);
      setPreparing(false);
    } else {
      for (const file of added) release(file);
    }
    preparingRef.current = false;
  };

  useEffect(() => {
    if (active) textarea.current?.focus();
  }, [active]);

  const messages = thread?.messages ?? [];
  const requests = thread ? derivePendingThreadRequests(thread) : { approvals: [], userInputs: [] };
  const running = ["preparing", "starting", "running", "waiting"].includes(
    runtime?.status ?? "idle",
  );
  useEffect(() => {
    if (followOutput.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Streamed messages and tool output change the scroll height.
  }, [thread?.messages, thread?.turnItems]);

  const act = async (operation: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (submitting.current) return false;
    submitting.current = true;
    setPending(true);
    setError(null);
    const result = await operation();
    submitting.current = false;
    setPending(false);
    if (result._tag === "Failure") {
      setError(String(Cause.squash(result.cause)));
      return false;
    }
    return true;
  };

  const send = async () => {
    const text = draft.trim();
    if (
      !thread ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      (!text && !files.length) ||
      preparing ||
      uploadError ||
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
          threadId: thread.thread.id,
          dispatchMode: "steer",
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
  const respond = async (
    requestId: Parameters<typeof approve>[0]["input"]["requestId"],
    decision: ProviderApprovalDecision,
  ) => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      requests.approvals.find((approval) => approval.requestId === requestId)
        ?.responseCapability !== "live"
    )
      return;
    await act(() => approve({ environmentId, input: { threadId, requestId, decision } }));
  };

  return (
    <section data-side-chat className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          </div>
        ))}
        {thread?.visibleTurnItems.map(({ item, visibility }) =>
          item.type === "secret_request" ? (
            <SecretRequestCard
              key={item.id}
              environmentId={environmentId}
              item={item}
              visibility={visibility}
            />
          ) : null,
        )}
        {running && <p className="text-xs text-muted-foreground">Working…</p>}
        {requests.approvals.map((approval) => (
          <div
            key={approval.requestId}
            className="my-3 rounded-lg border border-border p-3 text-sm"
          >
            <p>{approval.detail ?? `Permission requested: ${approval.requestKind}`}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <ComposerPendingApprovalActions
                requestId={approval.requestId}
                isResponding={pending}
                canRespond={canOperateThread && approval.responseCapability === "live"}
                disabled={!canOperateThread || approval.responseCapability !== "live"}
                options={approval.options}
                onRespondToApproval={respond}
              />
            </div>
          </div>
        ))}
        {requests.userInputs.map((input) => {
          const drafts = Object.fromEntries(
            input.questions.map((question) => [
              question.id,
              answers[input.requestId]?.[question.id] ??
                (question.initialAnswer === undefined
                  ? {}
                  : { customAnswer: question.initialAnswer }),
            ]),
          );
          const resolved = buildPendingUserInputAnswers(input.questions, drafts);
          const responseDisabled =
            pending || !canOperateThread || input.responseCapability === "not_resumable";
          return (
            <form
              key={input.requestId}
              className="my-3 space-y-3 rounded-lg border border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!responseDisabled && resolved)
                  void act(() =>
                    answer({
                      environmentId,
                      input: { threadId, requestId: input.requestId, answers: resolved },
                    }),
                  );
              }}
            >
              {input.questions.map((question) => (
                <fieldset key={question.id} disabled={responseDisabled} className="text-sm">
                  <legend>{question.question}</legend>
                  {question.options.map((option) => {
                    const value = option.value ?? option.label;
                    const selected =
                      drafts[question.id]?.selectedOptionValues?.includes(value) ?? false;
                    return (
                      <div key={value} className="mt-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          aria-pressed={selected}
                          aria-label={
                            option.description
                              ? `${option.label}: ${option.description}`
                              : option.label
                          }
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
                        </Button>
                      </div>
                    );
                  })}
                  {question.allowCustomAnswer !== false && (
                    <div className="mt-2">
                      <Textarea
                        size="sm"
                        rows={2}
                        aria-label={question.header || question.question}
                        placeholder="Your answer…"
                        value={drafts[question.id]?.customAnswer ?? ""}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [input.requestId]: {
                              ...current[input.requestId],
                              [question.id]: setPendingUserInputCustomAnswer(
                                current[input.requestId]?.[question.id],
                                event.target.value,
                                question,
                              ),
                            },
                          }))
                        }
                      />
                    </div>
                  )}
                </fieldset>
              ))}
              <Button type="submit" size="sm" disabled={responseDisabled || !resolved}>
                Reply
              </Button>
            </form>
          );
        })}
      </div>
      {(error || runtime?.lastError) && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {error ?? runtime?.lastError}
        </p>
      )}
      <div className="shrink-0 px-3 pt-1.5 sm:px-5 sm:pt-2">
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
                    rows={1}
                    className="block max-h-50 min-h-17.5 w-full resize-none overflow-y-auto bg-transparent leading-relaxed text-foreground outline-none placeholder:text-placeholder/75 [field-sizing:content] font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
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
                <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                  <SideChatControls active={active}>
                    <div className="shrink-0">
                      <ProviderModelPicker
                        environmentId={environmentId}
                        lockedProvider={null}
                        activeInstanceId={selection.instanceId}
                        model={selection.model}
                        instanceEntries={instanceEntries}
                        modelOptionsByInstance={models}
                        disabled={!thread || pending || running}
                        triggerAriaLabel="Side chat model"
                        onInstanceModelChange={(instanceId, model) =>
                          setSelection({ instanceId, model })
                        }
                      />
                    </div>
                    {entry && (
                      <div className="shrink-0">
                        <TraitsPicker
                          disabled={pending || running}
                          provider={entry.driverKind}
                          instanceId={entry.instanceId}
                          model={selection.model}
                          models={entry.models}
                          modelOptions={selection.options}
                          promptUltrathink={readPromptUltrathink(draft)}
                          onPromptEdit={setDraft}
                          planModeEnabled={settings.planModeEnabled}
                          onModelOptionsChange={(options) =>
                            setSelection((current) => ({ ...current, options: options ?? [] }))
                          }
                        />
                      </div>
                    )}
                    <div className="flex shrink-0 items-center gap-1">
                      <ComposerFooterModeControls
                        runtimeMode={runtimeMode}
                        runtimeModeOptions={runtimeModeOptions.map((mode) => ({
                          mode,
                          ...runtimeModeConfig[mode],
                        }))}
                        interactionMode={interactionMode}
                        showInteractionModeToggle={settings.planModeEnabled}
                        onRuntimeModeChange={setRuntimeMode}
                        onToggleInteractionMode={() =>
                          setInteractionMode((current) => (current === "plan" ? "default" : "plan"))
                        }
                      />
                    </div>
                  </SideChatControls>
                  <div className="flex shrink-0 items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Attach to side chat"
                      disabled={!canOperateThread || preparing || pending}
                      onClick={() => fileInput.current?.click()}
                    >
                      <PaperclipIcon className="size-4" />
                    </Button>
                    <ComposerPrimaryActions
                      compact={false}
                      followUpBehavior="steer"
                      allowAlternateFollowUp={false}
                      canOperateThread={canOperateThread}
                      pendingAction={null}
                      isRunning={!!running}
                      canInterrupt={!!running}
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
      <div
        aria-hidden
        className="h-[calc(env(safe-area-inset-bottom)+1rem)] shrink-0 sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
      />
    </section>
  );
}

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
  resolveProvidersForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  type ModelSelection,
  MessageId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  type ThreadId,
  type ChatAttachment,
} from "@t3tools/contracts";
import { Paperclip, SendHorizontal, Square, X } from "lucide-react";
import { flushSync } from "react-dom";
import {
  type FormEvent,
  type KeyboardEvent,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { baseInstanceId } from "../orchestrator/orchestratorInstance";
import {
  modelSelectionOf,
  NO_PICK,
  pickableInstances,
  type PickerValue,
  pickOf,
  selectionOf,
} from "../providers/providers";
import { failureText } from "../settings/failureText";
import { newId } from "../state/boards";
import { ensureOrchestratorInstance } from "../state/orchestrator";
import { engineProvidersAtom, serverEnvironment } from "../state/server";
import { uploadAttachments } from "../state/attachmentUploads";
import { interruptTurn, startTurn } from "../state/threads";
import { attachmentInputs } from "./attachments";
import { ModelPicker } from "./ModelPicker";
import {
  buildSlashItems,
  rankSlashItems,
  type SlashAction,
  type SlashItem,
  slashMessage,
  slashQuery,
} from "./slash";
import { MARK_SLASH, SlashMenu, slashOptionId } from "./SlashMenu";
import { useWorkspaceSnapshot } from "./workspaceSnapshot";

const SWITCH_BLOCKED =
  "This thread does not support switching providers after it has started. Start a new thread to use this model.";

const markShown = (chip: HTMLElement | null) => {
  if (chip !== null) performance.mark("board:attach-shown");
};

/**
 * The box that sends a message to the orchestrator or stops its turn, with the model picker for the
 * next turn and the slash menu that opens when the message starts with `/`.
 */
export function Composer({
  project,
  threadId,
  projection,
  live,
}: {
  project: EnvironmentProject;
  threadId: ThreadId;
  projection: OrchestrationV2ThreadProjection | null;
  live: boolean;
}) {
  const registry = useContext(RegistryContext);
  const { environmentId, workspaceRoot: cwd } = project;
  const menuId = useId();
  const input = useRef<HTMLTextAreaElement | null>(null);

  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [override, setOverride] = useState<PickerValue | null>(null);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement | null>(null);

  const providers = useAtomValue(engineProvidersAtom);
  const providersForCwd = useMemo(() => resolveProvidersForCwd(providers, cwd), [providers, cwd]);
  const instances = useMemo(() => pickableInstances(providersForCwd), [providersForCwd]);
  const thread = projection?.thread ?? null;
  // The thread runs on an orchestrator instance, which the picker shows as the instance it copies.
  const shown =
    override ??
    (thread === null
      ? NO_PICK
      : pickOf(instances, {
          ...thread.modelSelection,
          instanceId: ProviderInstanceId.make(baseInstanceId(thread.modelSelection.instanceId)),
        }));
  const provider = providersForCwd.find((entry) => entry.instanceId === shown.instanceId);
  const { refresh } = useWorkspaceSnapshot(environmentId, provider?.instanceId, cwd);
  const canFresh =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .freshContext === true && (projection?.messages.length ?? 0) > 0;
  const switchBlocked =
    projection !== null &&
    thread !== null &&
    projection.runs.length > 0 &&
    !threadSupportsProviderHandoff(projection)
      ? { reason: SWITCH_BLOCKED, stayOn: baseInstanceId(thread.modelSelection.instanceId) }
      : null;

  const query = slashQuery(draft, cursor);
  const onlyTheCommand = draft.slice(cursor).trim() === "";
  const open = query !== null && closedFor !== draft;
  const items = useMemo(
    () =>
      open && provider !== undefined
        ? buildSlashItems({
            commands: resolveProviderSlashCommandsForCwd(provider, cwd),
            skills: resolveProviderSkillsForCwd(provider, cwd),
            actions: ["model", ...(canFresh ? (["clear"] as const) : [])],
            messageIsOnlyTheCommand: onlyTheCommand,
          })
        : [],
    [open, provider, cwd, canFresh, onlyTheCommand],
  );
  const ranked = useMemo(() => rankSlashItems(items, query ?? ""), [items, query]);
  const highlighted = Math.min(active, Math.max(ranked.length - 1, 0));

  const addFiles = (added: File[]) => {
    const checked = attachmentInputs([...files, ...added]);
    if ("error" in checked) setError(checked.error);
    else {
      setError(null);
      setFiles([...files, ...added]);
    }
  };

  const edit = (value: string, at: number) => {
    if (MARK_SLASH && slashQuery(draft, cursor) === null && slashQuery(value, at) !== null) {
      performance.mark("board:slash-open");
    }
    if (slashQuery(draft, cursor) === null && slashQuery(value, at) !== null) refresh();
    setActive(0);
    setClosedFor(null);
    setDraft(value);
    setCursor(at);
  };

  const runAction = (action: SlashAction) => {
    setDraft(draft.slice(cursor));
    setCursor(0);
    if (action === "model") setModelOpen(true);
    else setFresh(true);
  };

  const pick = (item: SlashItem) => {
    if (item.action !== null) {
      runAction(item.action);
      return;
    }
    const text = `${slashMessage(item, "")} `;
    const rest = draft.slice(cursor);
    // A space already after the cursor serves as the one that follows the pick.
    const next = text + (rest.startsWith(" ") ? rest.slice(1) : rest);
    setActive(0);
    // The textarea must hold the text before the cursor can move past it.
    flushSync(() => setDraft(next));
    input.current?.setSelectionRange(text.length, text.length);
    setCursor(text.length);
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (text === "" || projection === null) return;
    setError(null);
    // Every turn goes out on the orchestrator instance, which also moves a board that started before it existed.
    let selection: ModelSelection | null = null;
    const picked = selectionOf(instances, shown);
    const base = modelSelectionOf(instances, shown);
    if (picked !== null && base !== null) {
      try {
        const instanceId = await ensureOrchestratorInstance(registry, environmentId, picked);
        if (override !== null || instanceId !== projection.thread.modelSelection.instanceId) {
          selection = { ...base, instanceId: ProviderInstanceId.make(instanceId) };
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return;
      }
    }
    let attachments: ChatAttachment[] = [];
    if (files.length > 0) {
      const checked = attachmentInputs(files);
      if ("error" in checked) {
        setError(checked.error);
        return;
      }
      try {
        attachments = await uploadAttachments(registry, environmentId, files, checked.inputs);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return;
      }
    }
    setDraft("");
    setCursor(0);
    const result = await runAtomCommand(
      registry,
      startTurn,
      {
        environmentId,
        input: {
          threadId,
          message: { messageId: MessageId.make(newId()), role: "user", text, attachments },
          runtimeMode: projection.thread.runtimeMode,
          interactionMode: projection.thread.interactionMode,
          ...(selection === null ? {} : { modelSelection: selection }),
          ...(fresh ? { freshContext: true } : {}),
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      setFresh(false);
      setFiles([]);
    } else {
      setDraft(text);
      setCursor(text.length);
      setError(failureText(result));
    }
  };

  const stop = async () => {
    setError(null);
    const result = await runAtomCommand(
      registry,
      interruptTurn,
      { environmentId, input: { threadId } },
      { reportFailure: false },
    );
    if (result._tag !== "Success") setError(failureText(result));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (open && ranked.length > 0) {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        setActive((highlighted + step + ranked.length) % ranked.length);
        event.preventDefault();
        return;
      }
      const chosen = ranked[highlighted];
      if (chosen !== undefined && (event.key === "Enter" || event.key === "Tab")) {
        if (event.key === "Enter" && event.shiftKey) return;
        pick(chosen);
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Escape" && open) {
      setClosedFor(draft);
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      void send();
      event.preventDefault();
    }
  };

  const highlightedItem = open ? ranked[highlighted] : undefined;

  return (
    <form
      onSubmit={(event) => void send(event)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        performance.mark("board:attach-drop");
        addFiles(Array.from(event.dataTransfer.files));
      }}
      className="relative shrink-0 border-t border-line p-2"
    >
      {open && (
        <SlashMenu
          id={menuId}
          items={ranked}
          active={highlighted}
          onPick={pick}
          onHover={setActive}
        />
      )}
      {error !== null && (
        <p role="alert" className="mb-1.5 break-words text-red-400">
          {error}
        </p>
      )}
      {fresh && (
        <p className="mb-1.5 flex items-center gap-2 text-muted">
          <span className="min-w-0 flex-1">The next message starts a fresh session.</span>
          <button type="button" onClick={() => setFresh(false)} className="hover:text-fg">
            Cancel
          </button>
        </p>
      )}
      <div className="flex flex-col gap-1 rounded-xl border border-line bg-panel p-2 focus-within:border-muted">
        {files.length > 0 && (
          <ul aria-label="Attached files" className="flex flex-wrap gap-1">
            {files.map((file, index) => (
              <li
                key={`${file.name}:${file.lastModified}:${file.size}`}
                ref={markShown}
                className="flex max-w-full items-center gap-1 rounded-md border border-line bg-hover px-1.5 text-[11px] leading-5 text-fg"
              >
                <span className="min-w-0 truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles(files.filter((_, at) => at !== index))}
                  className="text-muted hover:text-fg"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={input}
            value={draft}
            onChange={(event) => edit(event.target.value, event.target.selectionStart)}
            onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Message the orchestrator"
            aria-label="Message the orchestrator"
            role="combobox"
            aria-expanded={open}
            aria-controls={open && ranked.length > 0 ? menuId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              highlightedItem === undefined ? undefined : slashOptionId(menuId, highlightedItem)
            }
            className="max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent text-fg outline-none placeholder:text-faint"
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="attach-input"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            onClick={() => picker.current?.click()}
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
          >
            <Paperclip className="size-3.5" />
          </button>
          {live && draft.trim() === "" ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={() => void stop()}
              className="grid size-7 shrink-0 place-items-center rounded-full bg-fg text-bg"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={draft.trim() === ""}
              className="grid size-7 shrink-0 place-items-center rounded-full bg-fg text-bg disabled:opacity-40"
            >
              <SendHorizontal className="size-3.5" />
            </button>
          )}
        </div>
        <ModelPicker
          instances={instances}
          value={shown}
          onChange={setOverride}
          switchBlocked={switchBlocked}
          open={modelOpen}
          onOpenChange={(next) => {
            setModelOpen(next);
            if (!next) input.current?.focus();
          }}
        />
      </div>
    </form>
  );
}

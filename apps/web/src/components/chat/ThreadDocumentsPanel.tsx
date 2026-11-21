import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2GetThreadChangedFilesResult,
  OrchestrationV2ThreadChangedFile,
  ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon, ChevronDownIcon, CopyIcon, FileTextIcon, FolderOpenIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useFileContextMenu } from "../../fileContextMenu";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useQuietThreadProjection, useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
} from "../ui/anchoredCopyToast";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl, ThreadDetailsMoreButton } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";
import {
  resolveDocumentPath,
  splitDocumentPath,
  threadDocumentsRevision,
} from "./threadDocuments.logic";

// A short list opens by itself; a long one waits, like Previous agents.
const DOCUMENTS_OPEN_COUNT = 5;
// An agent can change many files in a burst; ask once it pauses.
const DOCUMENTS_REFRESH_DELAY_MS = 1_000;
const DOCUMENTS_PAGE_COUNT = 8;

interface ThreadDocumentsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Resolves relative paths a provider reports. */
  readonly workspaceRoot: string | null;
}

/** Files the thread's agents and the tasks they delegated created or changed. Hidden while none. */
export function ThreadDocumentsPanel(props: ThreadDocumentsPanelProps) {
  return <ThreadDocumentsList key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function ThreadDocumentsList(props: ThreadDocumentsPanelProps) {
  const gt = useGT();
  const supported = useServerConfigs().get(props.environmentId)?.threadChangedFiles === true;
  const structure = useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const revision = useDebouncedValue(
    threadDocumentsRevision(structure?.projection ?? null),
    DOCUMENTS_REFRESH_DELAY_MS,
  );
  const query = useEnvironmentQuery(
    supported
      ? orchestrationEnvironment.threadChangedFiles({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, revision },
        })
      : null,
  );
  // A new revision is a new query; keep the last answer on screen until it lands.
  const [shown, setShown] = useState<OrchestrationV2GetThreadChangedFilesResult | null>(null);
  // Whether the list starts open is decided by the first answer, so growing past the limit later
  // does not fold it away under the reader.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  if (query.data !== null && query.data !== shown) {
    setShown(query.data);
    if (expanded === null) setExpanded(query.data.files.length <= DOCUMENTS_OPEN_COUNT);
  }
  const files = shown?.files ?? [];
  const [visibleCount, setVisibleCount] = useState(DOCUMENTS_PAGE_COUNT);
  if (!supported || files.length === 0) return null;
  const open = expanded ?? files.length <= DOCUMENTS_OPEN_COUNT;
  const hiddenCount = Math.max(0, files.length - visibleCount);

  return (
    <ThreadDetailsSection
      headingId="thread-details-documents-heading"
      title={gt("Documents", { $context: "thread details section: files the agents changed" })}
      showHeading={false}
      data-thread-documents-panel
    >
      <div>
        <ThreadDetailsControl aria-expanded={open} onClick={() => setExpanded(!open)}>
          <FileTextIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
            {gt("Documents", { $context: "thread details section: files the agents changed" })}
          </span>
          {open ? null : (
            <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
              {shown?.truncated ? `${files.length}+` : files.length}
            </span>
          )}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              THREAD_DETAILS_PANEL_CHEVRON_CLASS,
              "transition-transform",
              !open && "-rotate-90",
            )}
          />
        </ThreadDetailsControl>
        {open ? (
          <>
            <ul
              aria-label={gt("Documents", {
                $context: "thread details section: files the agents changed",
              })}
              className="m-0 max-h-[17rem] list-none overflow-y-auto p-0"
            >
              {files.slice(0, visibleCount).map((file) => (
                <ThreadDocumentRow
                  key={file.path}
                  environmentId={props.environmentId}
                  file={file}
                  workspaceRoot={props.workspaceRoot}
                />
              ))}
            </ul>
            {files.length > DOCUMENTS_PAGE_COUNT ? (
              <ThreadDetailsMoreButton
                expanded={hiddenCount === 0}
                remaining={Math.min(hiddenCount, DOCUMENTS_PAGE_COUNT)}
                onToggle={() =>
                  setVisibleCount(
                    hiddenCount > 0 ? visibleCount + DOCUMENTS_PAGE_COUNT : DOCUMENTS_PAGE_COUNT,
                  )
                }
              />
            ) : null}
          </>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function ThreadDocumentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly file: OrchestrationV2ThreadChangedFile;
  readonly workspaceRoot: string | null;
}) {
  const gt = useGT();
  const copyRef = useRef<HTMLButtonElement>(null);
  const { capabilities } = useFileContextMenu(props.environmentId);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) => showAnchoredCopyErrorToast(copyRef, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  const absolutePath = resolveDocumentPath(props.file.path, props.workspaceRoot);
  const { name, folder } = splitDocumentPath(props.file.path);
  const displayPath = absolutePath ?? props.file.path;
  const copyPath = () =>
    copyToClipboard(
      formatFilePathForClipboard(displayPath, props.workspaceRoot ?? undefined),
      undefined,
    );

  const launch = async (reveal: boolean) => {
    if (absolutePath === null) return;
    const result = await openInEditor({
      environmentId: props.environmentId,
      input: { cwd: absolutePath, editor: "file-manager", ...(reveal ? { reveal: true } : {}) },
    });
    if (result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title: reveal ? gt("Unable to reveal file") : gt("Could not open file"),
      description: absolutePath,
    });
  };
  // Without a default app on the environment (no file manager there), the path is what helps.
  const canOpen = capabilities.canOpenDefault && absolutePath !== null;
  const canReveal = capabilities.revealLabel !== undefined && absolutePath !== null;

  return (
    <li className="group relative flex items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={300}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              onClick={() => (canOpen ? void launch(false) : copyPath())}
            />
          }
        >
          <FileTextIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          {/* While the row's actions show, the end padding keeps the name clear of them. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 group-hover:pe-12 group-focus-within:pe-12 pointer-coarse:pe-12 [@media(hover:none)]:pe-12">
            <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 shrink truncate")}>
              {name}
            </span>
            {folder ? (
              <span className="min-w-0 flex-1 truncate text-2xs font-normal text-muted-foreground">
                {folder}
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-96 break-all">
          {displayPath}
        </TooltipPopup>
      </Tooltip>
      <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
        {canReveal ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label={capabilities.revealLabel}
                  onClick={() => void launch(true)}
                />
              }
            >
              <FolderOpenIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">{capabilities.revealLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                ref={copyRef}
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label={gt("Copy path")}
                onClick={copyPath}
              />
            }
          >
            {isCopied ? (
              <CheckIcon aria-hidden className="size-3.5 text-success" />
            ) : (
              <CopyIcon aria-hidden className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="left">{isCopied ? gt("Copied") : gt("Copy path")}</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}

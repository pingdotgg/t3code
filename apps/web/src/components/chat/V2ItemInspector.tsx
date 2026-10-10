import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  toolCallLines,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { ExternalLinkIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { memo, type ReactNode, Suspense, use, useMemo } from "react";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { useTurnItemDetail } from "../../state/queries";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Button } from "../ui/button";
import ChatMarkdown, { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { ShellCommandBlock } from "./ShellCommandBlock";

interface V2ItemInspectorProps {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  readonly onRollbackCheckpoint?: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function JsonTokens({ text }: { readonly text: string }) {
  const { resolvedTheme } = useTheme();
  const highlighter = use(getSyntaxHighlighterPromise("json"));
  const { tokens } = useMemo(
    () =>
      highlighter.codeToTokens(text, { lang: "json", theme: resolveDiffThemeName(resolvedTheme) }),
    [highlighter, text, resolvedTheme],
  );
  return tokens.flatMap((line, lineIndex) => [
    lineIndex > 0 ? "\n" : "",
    ...line.map((token) => (
      <span key={token.offset} style={{ color: token.color }}>
        {token.content}
      </span>
    )),
  ]);
}

const monoClassName =
  "font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed whitespace-pre-wrap break-words select-text";

function StructuredValue({
  value,
  highlightJson = false,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isJson = useMemo(() => {
    if (!highlightJson || !text) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }, [highlightJson, text]);
  if (!text) return null;
  return (
    <pre className={cn("max-h-80 overflow-auto text-muted-foreground", monoClassName)}>
      {isJson ? (
        <RenderErrorBoundary fallback={text}>
          <Suspense fallback={text}>
            <JsonTokens text={text} />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        text
      )}
    </pre>
  );
}

/**
 * The item behind a projected row, with the output the timeline withheld
 * fetched while the row is open.
 */
function useFetchedTurnItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  environmentId: EnvironmentId,
  skip = false,
) {
  const wireItem = projectedItem.item;
  const fetches = !skip && turnItemNeedsDetailFetch(wireItem);
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
  );
  const fetchedItem = detail.data?.item;
  const item = fetchedItem?.type === wireItem.type ? fetchedItem : wireItem;
  return {
    item,
    output: {
      output: turnItemOutputText(item),
      images: turnItemOutputImages(item),
      environmentId,
      pending: item === wireItem && detail.isPending,
      error:
        item !== wireItem
          ? null
          : detail.data?.item === null
            ? "Output is no longer available."
            : detail.error,
      empty: fetches && item !== wireItem,
    },
  };
}

interface ToolOutputState {
  readonly output: string | null;
  readonly images: ReturnType<typeof turnItemOutputImages>;
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly error: string | null;
  readonly empty: boolean;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function ToolOutput(props: ToolOutputState) {
  const images = props.images.map((resource) => (
    <ChatMarkdownAssetImage
      key={resource.index}
      environmentId={props.environmentId}
      resource={resource}
      alt="Tool output image"
      maxHeightRem={16}
      onImageExpand={props.onImageExpand}
    />
  ));
  const text = props.output ? (
    <div className="max-h-80 overflow-auto text-muted-foreground">{props.output}</div>
  ) : props.pending ? (
    <div className="text-muted-foreground italic">Loading output…</div>
  ) : props.error ? (
    <div className="text-destructive">Couldn&apos;t load output: {props.error}</div>
  ) : props.empty && images.length === 0 ? (
    <div className="text-muted-foreground italic">No output.</div>
  ) : null;
  return (
    <>
      {images}
      {text}
    </>
  );
}

/** Fetched output for rows that show their own plain text instead of the inspector. */
export function FetchedToolOutput(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { output } = useFetchedTurnItem(props.projectedItem, props.environmentId);
  return (
    <div className={cn("mt-1.5 space-y-1.5", monoClassName)}>
      <ToolOutput {...output} onImageExpand={props.onImageExpand} />
    </div>
  );
}

/** A tool call's body: the call itself in the foreground, its result muted below. */
function ToolCallBody(
  props: ToolOutputState & {
    readonly command?: string;
    readonly args?: unknown;
    readonly exitCode?: number | undefined;
    /** Replaces the fetched output, e.g. with a command's live output. */
    readonly outputSlot?: ReactNode;
  },
) {
  const call = toolCallLines({ command: props.command, args: props.args });
  return (
    <div className={cn("space-y-1.5", monoClassName)}>
      {call.command ? <ShellCommandBlock command={call.command} /> : null}
      {call.args ? (
        <div className="text-foreground/85">
          {call.args.map(([key, value]) => (
            <div key={key}>
              <span className="text-muted-foreground">{key} </span>
              {value}
            </div>
          ))}
        </div>
      ) : null}
      {call.argsText ? <StructuredValue value={call.argsText} highlightJson /> : null}
      {props.outputSlot ?? <ToolOutput {...props} />}
      {props.exitCode !== undefined && props.exitCode !== 0 ? (
        <div className="text-destructive">exit {props.exitCode}</div>
      ) : null}
    </div>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  // Command rows stream their output, including the final output, from the server.
  const streamsOutput =
    useCommandOutputStreaming(props.environmentId) &&
    props.projectedItem.item.type === "command_execution";
  const fetched = useFetchedTurnItem(props.projectedItem, props.environmentId, streamsOutput);
  const item = fetched.item;
  const outputState = fetched.output;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown
            text={item.text}
            cwd={props.cwd}
            threadRef={{
              environmentId: props.environmentId,
              threadId: props.projectedItem.sourceThreadId,
            }}
            lineBreaks
          />
        </div>
      ) : null}

      {item.type === "command_execution" ? (
        <ToolCallBody
          command={item.input}
          exitCode={item.exitCode}
          {...outputState}
          onImageExpand={props.onImageExpand}
          outputSlot={
            streamsOutput ? (
              <CommandOutputPanel
                environmentId={props.environmentId}
                threadId={props.projectedItem.sourceThreadId}
                itemId={props.projectedItem.sourceItemId}
              />
            ) : undefined
          }
        />
      ) : null}

      {item.type === "file_change" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-muted-foreground">
              {formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}
            </span>
            {item.additions !== undefined || item.deletions !== undefined ? (
              <span>
                <span className="text-success">+{item.additions ?? 0}</span>{" "}
                <span className="text-destructive">-{item.deletions ?? 0}</span>
              </span>
            ) : null}
            {item.runId !== null ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onOpenTurnDiff(item.runId!, item.fileName)}
              >
                Open diff
              </Button>
            ) : null}
          </div>
          {item.status === "failed" && item.diffStr?.trim() ? (
            <StructuredValue value={item.diffStr} />
          ) : null}
          {item.changes !== undefined && item.changes.length > 0 ? (
            <ul className="space-y-1 font-mono text-muted-foreground">
              {item.changes.map((change, index) => (
                <li key={`${change.operation}:${change.path}:${index}`}>
                  {change.operation} {change.oldPath ? `${change.oldPath} → ` : ""}
                  {formatWorkspaceRelativePath(change.path, props.workspaceRoot)}
                  {change.fileType || change.mimeType
                    ? ` (${[change.fileType, change.mimeType].filter(Boolean).join(", ")})`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {item.type === "file_search" && item.pattern?.trim() ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.pattern}</div>
      ) : null}

      {item.type === "web_search" && item.patterns?.length ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.patterns.join("\n")}</div>
      ) : null}

      {item.type === "file_search" && item.results?.length ? (
        <ul className="space-y-1">
          {item.results.map((result) => (
            <li key={JSON.stringify(result)}>
              <span className="font-mono text-foreground/80">
                {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                {result.line === undefined ? "" : `:${result.line}`}
                {result.column === undefined ? "" : `:${result.column}`}
              </span>
              {result.preview ? (
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{result.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.results?.length ? (
        <ul className="space-y-1.5">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)}>
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                  >
                    {result.title ?? result.url}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <p className="font-medium text-foreground">
                    {result.title ?? result.url ?? "Search result"}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <ToolCallBody args={item.input} {...outputState} onImageExpand={props.onImageExpand} />
      ) : null}

      {item.type === "approval_request" ? <StructuredValue value={item.prompt} /> : null}
      {item.type === "user_input_request" ? (
        <StructuredValue value={item.questions.map((question) => question.question).join("\n\n")} />
      ) : null}
      {item.type === "notification" ? <StructuredValue value={item.detail} /> : null}
      {item.type === "system_notice" ? <StructuredValue value={item.message} /> : null}
      {item.type === "error" ? <StructuredValue value={item.failure.message} /> : null}
      {item.type === "proposed_plan" ? <StructuredValue value={item.markdown} /> : null}
      {item.type === "todo_list" ? (
        <StructuredValue
          value={item.steps
            .map((step) => `${step.status === "completed" ? "✓" : "○"} ${step.text}`)
            .join("\n")}
        />
      ) : null}

      {item.type === "checkpoint" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {support.checkpoint?.status ?? item.status} · {item.files.length} files
          </span>
          {props.onRollbackCheckpoint && support.checkpoint?.status === "ready" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.onRollbackCheckpoint?.({
                  checkpointId: item.checkpointId,
                  scopeId: item.scopeId,
                })
              }
            >
              <RotateCcwIcon className="size-3" />
              Roll back
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.type === "fork" ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.targetThreadId)}>
          <GitBranchIcon className="size-3" />
          Open fork
        </Button>
      ) : null}

      {item.type === "subagent" && item.childThreadId !== null ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.childThreadId!)}>
          Open subagent thread
        </Button>
      ) : null}

      {item.type === "handoff" ? (
        <div className="space-y-1 text-muted-foreground">
          <p>
            {item.fromProviderInstanceIds.join(", ")} → {item.toProviderInstanceId}
          </p>
          <p>
            {item.strategy.replaceAll("_", " ")} · {support.contextHandoff?.status ?? item.status}
          </p>
          {support.contextTransfer ? (
            <p>
              Transfer {support.contextTransfer.type.replaceAll("_", " ")} ·{" "}
              {support.contextTransfer.status}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

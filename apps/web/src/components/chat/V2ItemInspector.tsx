import { T, Var, useGT } from "gt-react";
import type { ToolCallDiffTarget } from "../../diffPanelStore";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isJsonToolText,
  toolCallLines,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { ExternalLinkIcon } from "lucide-react";
import { memo, type ReactNode, Suspense, use } from "react";

import { canOpenLinksInApp, resolveLinkTarget } from "../../browser/browserLinkTarget";
import { useOpenLink } from "../../browser/useOpenLink";
import { useClientSettings } from "../../hooks/useSettings";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { useTurnItemDetail } from "../../state/queries";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { FileSearchResults } from "./FileSearchResults";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { useInitialOutputReady, type TurnItemSource } from "./timelineRowContext";
import { formatFileChangeLine } from "./V2ItemInspector.logic";

interface V2ItemInspectorProps {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenToolDiff?: ((target: ToolCallDiffTarget) => void) | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}

function SyntaxTokens({
  text,
  language,
}: {
  readonly text: string;
  readonly language: "json" | "typescript" | "html";
}) {
  const resolvedTheme = useRenderedAppearance();
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const { tokens } = highlighter.codeToTokens(text, {
    lang: language,
    theme: resolveDiffThemeName(resolvedTheme),
  });
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
  language,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
  readonly language?: "typescript" | "html" | "json";
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isJson = highlightJson && isJsonToolText(text);
  if (!text) return null;
  return (
    <pre className={cn("max-h-80 overflow-auto text-muted-foreground", monoClassName)}>
      {language || isJson ? (
        <RenderErrorBoundary fallback={text}>
          <Suspense fallback={text}>
            <SyntaxTokens text={text} language={language ?? "json"} />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        text
      )}
    </pre>
  );
}

function useFetchedTurnItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  environmentId: EnvironmentId,
  source: TurnItemSource | undefined,
  skip = false,
) {
  const gt = useGT();
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
    source?.detail,
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
            ? gt("Output is no longer available.")
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

function ToolOutputImages(props: ToolOutputState) {
  const gt = useGT();
  return props.images.map((resource) => (
    <ChatMarkdownAssetImage
      key={resource.index}
      environmentId={props.environmentId}
      resource={resource}
      alt={gt("Tool output image")}
      maxHeightRem={16}
      onImageExpand={props.onImageExpand}
    />
  ));
}

function ToolOutput(props: ToolOutputState) {
  return props.output ? (
    <StructuredValue value={props.output} highlightJson />
  ) : props.pending ? (
    <div className="text-muted-foreground italic">
      <T>Loading output…</T>
    </div>
  ) : props.error ? (
    <div className="text-destructive">
      <T>
        Couldn&apos;t load output: <Var>{props.error}</Var>
      </T>
    </div>
  ) : props.empty && props.images.length === 0 ? (
    <div className="text-muted-foreground italic">
      <T>No output.</T>
    </div>
  ) : null;
}

export function FetchedToolOutput(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}) {
  const { output } = useFetchedTurnItem(props.projectedItem, props.environmentId, props.source);
  useInitialOutputReady(output.pending, props.onInitialOutputReady);
  return (
    <div className={cn("mt-1.5 space-y-1.5", monoClassName)}>
      <ToolOutputImages {...output} onImageExpand={props.onImageExpand} />
      <ToolOutput {...output} onImageExpand={props.onImageExpand} />
    </div>
  );
}

function WebSearchResultLink(props: {
  readonly href: string;
  readonly threadRef: ScopedThreadRef;
  readonly children: ReactNode;
}) {
  const openLink = useOpenLink(props.threadRef);
  // Subscribe so the synchronous _blank decision sees hydrated settings, as ChatMarkdown does.
  const linkTargetPreference = useClientSettings((settings) => settings.browserLinkTarget);
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
      onClick={(event) => {
        if (
          resolveLinkTarget({
            url: props.href,
            event,
            preference: linkTargetPreference,
            canOpenInApp: canOpenLinksInApp(props.threadRef),
          }) !== "app"
        ) {
          return;
        }
        event.preventDefault();
        void openLink(props.href, { event }).catch(console.error);
      }}
    >
      {props.children}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}

function ToolCallBody(
  props: ToolOutputState & {
    readonly command?: string;
    readonly args?: unknown;
    readonly toolName?: string | null;
    readonly exitCode?: number | undefined;
    /** Replaces fetched output. */
    readonly outputSlot?: ReactNode;
  },
) {
  const call = toolCallLines({ command: props.command, args: props.args });
  return (
    <div className={cn("space-y-1.5", monoClassName)}>
      <ToolOutputImages {...props} />
      {call.command ? <ShellCommandBlock command={call.command} /> : null}
      {call.args ? (
        <div className="text-foreground/85">
          {call.args.map(([key, value]) => (
            <div key={key}>
              <span className="text-muted-foreground">{key} </span>
              {key === "html" ? (
                <StructuredValue value={value} language="html" />
              ) : key === "code" && isJavaScriptReplTool(props.toolName) ? (
                <StructuredValue value={value} language="typescript" />
              ) : isJsonToolText(value) ? (
                <StructuredValue value={value} language="json" />
              ) : (
                value
              )}
            </div>
          ))}
        </div>
      ) : null}
      {call.argsText ? <StructuredValue value={call.argsText} highlightJson /> : null}
      {props.outputSlot ?? <ToolOutput {...props} />}
      {props.exitCode !== undefined && props.exitCode !== 0 ? (
        <div className="text-destructive">
          <T>
            exit <Var>{props.exitCode}</Var>
          </T>
        </div>
      ) : null}
    </div>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  const gt = useGT();
  // Command rows stream their output, including the final output, from the server.
  const environmentStreamsOutput = useCommandOutputStreaming(props.environmentId);
  const streamsOutput =
    (props.source === undefined
      ? environmentStreamsOutput
      : props.source.commandOutput !== undefined) &&
    props.projectedItem.item.type === "command_execution";
  const fetched = useFetchedTurnItem(
    props.projectedItem,
    props.environmentId,
    props.source,
    streamsOutput,
  );
  const item = fetched.item;
  const outputState = fetched.output;
  useInitialOutputReady(streamsOutput || outputState.pending, props.onInitialOutputReady);
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
                onInitialOutputReady={props.onInitialOutputReady}
                environmentId={props.environmentId}
                threadId={props.projectedItem.sourceThreadId}
                itemId={props.projectedItem.sourceItemId}
                source={props.source?.commandOutput}
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
                <span className="text-diff-addition">+{formatDiffCount(item.additions ?? 0)}</span>{" "}
                <span className="text-diff-deletion">-{formatDiffCount(item.deletions ?? 0)}</span>
              </span>
            ) : null}
            {props.onOpenToolDiff ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  props.onOpenToolDiff?.({
                    threadId: props.projectedItem.sourceThreadId,
                    itemId: props.projectedItem.sourceItemId,
                    revision: turnItemDetailRevision(item),
                  })
                }
              >
                <T>Open diff</T>
              </Button>
            ) : null}
          </div>
          {item.status === "failed" && item.diffStr?.trim() ? (
            <StructuredValue value={item.diffStr} />
          ) : null}
          {item.changes !== undefined && item.changes.length > 0 ? (
            <ul className="space-y-1 font-mono text-muted-foreground">
              {item.changes.map((change) => (
                <li key={JSON.stringify([change.operation, change.oldPath, change.path])}>
                  {formatFileChangeLine(change, props.workspaceRoot)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* The row label already shows the pattern unless the provider titled the search itself. */}
      {item.type === "file_search" &&
      item.pattern?.trim() &&
      item.title &&
      !item.title.includes(item.pattern.trim()) ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.pattern}</div>
      ) : null}

      {item.type === "web_search" && item.patterns?.length ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.patterns.join("\n")}</div>
      ) : null}

      {item.type === "file_search" && item.results?.length ? (
        <FileSearchResults
          pattern={item.pattern}
          results={item.results}
          workspaceRoot={props.workspaceRoot}
        />
      ) : null}

      {item.type === "web_search" && item.results?.length ? (
        <ul className="space-y-1.5">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)}>
                {safeHref ? (
                  <WebSearchResultLink
                    href={safeHref}
                    threadRef={{
                      environmentId: props.environmentId,
                      threadId: props.projectedItem.sourceThreadId,
                    }}
                  >
                    {result.title ?? result.url}
                  </WebSearchResultLink>
                ) : (
                  <p className="font-medium text-foreground">
                    {result.title ?? result.url ?? gt("Search result")}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <ToolCallBody
          toolName={item.toolName}
          args={item.input}
          {...outputState}
          onImageExpand={props.onImageExpand}
        />
      ) : null}

      {item.type === "approval_request" ? <StructuredValue value={item.prompt} /> : null}
      {item.type === "user_input_request" ? (
        <StructuredValue
          value={item.questions
            .map((question) =>
              [question.question, ...question.options.map((option) => `• ${option.label}`)].join(
                "\n",
              ),
            )
            .join("\n\n")}
        />
      ) : null}
      {item.type === "notification" ? <StructuredValue value={item.detail} /> : null}
      {item.type === "system_notice" ? <StructuredValue value={item.message} /> : null}
      {item.type === "error" ? <StructuredValue value={item.failure.message} /> : null}
      {item.type === "todo_list" ? (
        <StructuredValue
          value={item.steps
            .map(
              (step) =>
                `${step.status === "completed" ? "✓" : step.status === "running" ? "◉" : "○"} ${step.text}`,
            )
            .join("\n")}
        />
      ) : null}
    </div>
  );
});

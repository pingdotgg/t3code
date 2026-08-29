import {
  UseAgentUpdate,
  useAgent,
  useAgentContext,
  useCopilotKit,
  useFrontendTool,
  useRenderToolCall,
} from "@copilotkit/react-core/v2/headless";
import { CopilotKitContext, CopilotKitCoreReact } from "@copilotkit/react-core/v2/context";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  FileCode2Icon,
  GitBranchIcon,
  RefreshCwIcon,
  SearchCodeIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { newMessageId } from "~/lib/utils";
import { reviewEnvironment } from "~/state/review";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import {
  buildReviewDiffContext,
  reviewSubmissionProblem,
  safeWorkspaceRelativePath,
  selectCompleteReviewDiffSources,
  type ReviewDiffContext,
  type ReviewFinding,
  type ReviewProgressItem,
  type ReviewSubmission,
  type ReviewVerdict,
} from "./copilotReview.logic";

const REVIEW_AGENT_ID = "review";
const REVIEW_AGENT_UPDATES = [
  UseAgentUpdate.OnMessagesChanged,
  UseAgentUpdate.OnRunStatusChanged,
] as const;

const severitySchema = z.enum(["critical", "high", "medium", "low"]);
const findingSchema = z.object({
  id: z.string().min(1).max(120),
  severity: severitySchema,
  title: z.string().min(1).max(160),
  file: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
  explanation: z.string().min(1).max(1_200),
  suggestedFix: z.string().min(1).max(1_200),
});
const reviewProgressSchema = z.object({
  stage: z.enum(["mapping", "correctness", "security", "performance", "finalizing"]),
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(320),
  files: z.array(z.string().min(1).max(500)).max(12).default([]),
});
const reviewSubmissionSchema = z.object({
  verdict: z.enum(["ready", "needs-work", "blocked"]),
  summary: z.string().min(1).max(500),
  changedFiles: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  findings: z.array(findingSchema).max(50),
});
const reviewInspectionResultSchema = z.object({
  summary: z.object({
    changedFiles: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  ),
});
const reviewProgressResultSchema = z.object({
  recorded: z.literal(true),
  progress: reviewProgressSchema,
});
const reviewSubmissionResultSchema = z.object({
  accepted: z.literal(true),
  findings: z.number().int().nonnegative(),
});

type ReviewPhase = "connecting" | "inspecting" | "reviewing" | "complete" | "error";
type ReviewInspection = Pick<ReviewDiffContext, "summary" | "files">;

export interface CopilotReviewAgentProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly projectName: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly reviewRequestId: number;
  readonly onOpenFile: (relativePath: string) => void;
}

function readableReviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/openrouter|api[ -]?key|unauthorized|401/i.test(message)) {
    return "The review model is not configured. Add an OpenRouter API key in Settings → CopilotKit and try again.";
  }
  if (/fetch|network|connect|socket/i.test(message)) {
    return "T3 Code could not reach the review runtime. Check the server connection and try again.";
  }
  return message.trim() || "The review stopped before it produced a result.";
}

function verdictPresentation(verdict: ReviewVerdict) {
  switch (verdict) {
    case "ready":
      return { label: "Ready", variant: "success" as const, icon: CheckCircle2Icon };
    case "blocked":
      return { label: "Blocked", variant: "error" as const, icon: AlertTriangleIcon };
    case "needs-work":
      return { label: "Needs work", variant: "warning" as const, icon: CircleDotIcon };
  }
}

function severityVariant(severity: ReviewFinding["severity"]) {
  switch (severity) {
    case "critical":
    case "high":
      return "error" as const;
    case "medium":
      return "warning" as const;
    case "low":
      return "info" as const;
  }
}

function HeadlessCopilotProvider({
  children,
  runtimeUrl,
  headers,
  onError,
}: {
  readonly children: ReactNode;
  readonly runtimeUrl: string;
  readonly headers: Record<string, string>;
  readonly onError: (error: Error) => void;
}) {
  const coreRef = useRef<CopilotKitCoreReact | null>(null);
  const onErrorRef = useRef(onError);
  if (coreRef.current === null) {
    coreRef.current = new CopilotKitCoreReact({
      runtimeUrl,
      headers,
      credentials: "include",
      deferInitialConnection: true,
    });
    coreRef.current.setDefaultThrottleMs(75);
  }
  const copilotkit = coreRef.current;
  const [executingToolCallIds, setExecutingToolCallIds] = useState(() => new Set<string>());

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => onErrorRef.current(error),
    });
    return () => subscription.unsubscribe();
  }, [copilotkit]);

  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onToolExecutionStart: ({ toolCallId }) => {
        setExecutingToolCallIds((current) => new Set(current).add(toolCallId));
      },
      onToolExecutionEnd: ({ toolCallId }) => {
        setExecutingToolCallIds((current) => {
          if (!current.has(toolCallId)) return current;
          const next = new Set(current);
          next.delete(toolCallId);
          return next;
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit]);

  useEffect(() => {
    copilotkit.setRuntimeUrl(runtimeUrl);
    copilotkit.setHeaders(headers);
    copilotkit.setCredentials("include");
    copilotkit.connect();
  }, [copilotkit, headers, runtimeUrl]);

  const contextValue = useMemo(
    () => ({ copilotkit, executingToolCallIds }),
    [copilotkit, executingToolCallIds],
  );

  return <CopilotKitContext.Provider value={contextValue}>{children}</CopilotKitContext.Provider>;
}

function ReviewStatus({ phase }: { readonly phase: ReviewPhase }) {
  if (phase === "complete") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-success-foreground">
        <CheckCircle2Icon className="size-3.5" />
        Review complete
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive-foreground">
        <AlertTriangleIcon className="size-3.5" />
        Review stopped
      </span>
    );
  }
  const label =
    phase === "connecting"
      ? "Connecting"
      : phase === "inspecting"
        ? "Reading the diff"
        : "Reviewing changes";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CircleDotIcon className="size-3.5 text-primary" />
      {label}
    </span>
  );
}

function parseToolResult(result: string | undefined): unknown {
  if (result === undefined) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function ReviewToolStep({
  active,
  detail,
  tool,
  title,
}: {
  readonly active: boolean;
  readonly detail: string;
  readonly tool: string;
  readonly title: string;
}) {
  return (
    <section className="border-b border-border/70 px-3 py-3" data-copilotkit-genui={tool}>
      <div className="flex items-start gap-2.5">
        <div className="pt-0.5">
          {active ? (
            <SearchCodeIcon className="size-3.5 text-primary" />
          ) : (
            <CheckCircle2Icon className="size-3.5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium">{title}</p>
            <Badge size="sm" variant="outline">
              {tool}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">{detail}</p>
        </div>
      </div>
    </section>
  );
}

function ReviewProgress({
  active,
  item,
  onOpenFile,
}: {
  readonly active: boolean;
  readonly item: ReviewProgressItem;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const files = item.files.flatMap((file) => {
    const path = safeWorkspaceRelativePath(file);
    return path === null ? [] : [path];
  });
  return (
    <section
      className="border-b border-border/70 px-3 py-3"
      data-copilotkit-genui="report_review_progress"
    >
      <div className="flex items-start gap-2.5">
        <div className="pt-0.5">
          {active ? (
            <SearchCodeIcon className="size-3.5 text-primary" />
          ) : (
            <CheckCircle2Icon className="size-3.5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium">{item.title}</p>
            <Badge size="sm" variant="outline">
              {item.stage}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">{item.detail}</p>
          {files.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {files.map((file) => (
                <Button
                  className="max-w-full justify-start px-1.5 font-mono text-[10px]"
                  key={file}
                  onClick={() => onOpenFile(file)}
                  size="micro"
                  variant="ghost"
                >
                  <FileCode2Icon />
                  <span className="truncate">{file}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ReviewFiles({
  inspection,
  onOpenFile,
}: {
  readonly inspection: ReviewInspection;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const visibleFiles = inspection.files.slice(0, 16);
  return (
    <section className="border-b border-border/70 px-3 py-3" data-copilotkit-genui="inspect_branch">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <CheckCircle2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="truncate text-xs font-medium">Branch mapped</p>
        </div>
        <Badge className="shrink-0" size="sm" variant="outline">
          inspect_branch
        </Badge>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {inspection.summary.changedFiles} files, +{inspection.summary.additions} -
        {inspection.summary.deletions}
      </p>
      <div className="space-y-0.5">
        {visibleFiles.map((file) => (
          <button
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/60"
            key={file.path}
            onClick={() => onOpenFile(file.path)}
            type="button"
          >
            <FileCode2Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate">{file.path}</code>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              +{file.additions} -{file.deletions}
            </span>
          </button>
        ))}
      </div>
      {inspection.files.length > visibleFiles.length ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {inspection.files.length - visibleFiles.length} more files are included in the review.
        </p>
      ) : null}
    </section>
  );
}

function ReviewResult({
  result,
  onOpenFile,
}: {
  readonly result: ReviewSubmission;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const presentation = verdictPresentation(result.verdict);
  const VerdictIcon = presentation.icon;
  return (
    <section data-copilotkit-genui="submit_review">
      <div className="border-b border-border/70 px-3 py-3">
        <div className="mb-2 flex items-center gap-2">
          <SparklesIcon className="size-3.5 text-primary" />
          <p className="text-xs font-medium">Generated review</p>
          <Badge size="sm" variant="outline">
            submit_review
          </Badge>
        </div>
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium leading-5">{result.summary}</p>
          <Badge className="shrink-0" size="sm" variant={presentation.variant}>
            <VerdictIcon />
            {presentation.label}
          </Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {result.changedFiles} files, +{result.additions} -{result.deletions}
        </p>
      </div>

      {result.findings.length === 0 ? (
        <div className="flex items-start gap-2.5 px-3 py-4 text-sm text-success-foreground">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
          <p>No actionable problems found in the current diff.</p>
        </div>
      ) : (
        <div>
          {result.findings.map((finding) => {
            const path = safeWorkspaceRelativePath(finding.file);
            return (
              <article
                className="border-b border-border/70 px-3 py-3 last:border-b-0"
                key={finding.id}
              >
                <div className="flex items-start gap-2">
                  <Badge
                    className="mt-0.5 shrink-0"
                    size="sm"
                    variant={severityVariant(finding.severity)}
                  >
                    {finding.severity}
                  </Badge>
                  <p className="text-sm font-medium leading-5">{finding.title}</p>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {finding.explanation}
                </p>
                <div className="mt-2 rounded-md bg-muted/40 px-2.5 py-2">
                  <p className="text-[11px] font-medium text-muted-foreground">Suggested fix</p>
                  <p className="mt-1 text-xs leading-4">{finding.suggestedFix}</p>
                </div>
                <Button
                  className="mt-2 max-w-full justify-start px-1.5 font-mono text-[11px]"
                  disabled={path === null}
                  onClick={() => path && onOpenFile(path)}
                  size="micro"
                  variant="ghost"
                >
                  <FileCode2Icon />
                  <span className="truncate">
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </span>
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ReviewPane(
  props: CopilotReviewAgentProps & {
    readonly runtimeError: Error | null;
    readonly clearRuntimeError: () => void;
    readonly getRuntimeError: () => Error | null;
  },
) {
  const { clearRuntimeError, getRuntimeError } = props;
  const runDiffPreview = useAtomQueryRunner(reviewEnvironment.diffPreview, {
    reportFailure: false,
  });
  const localAgentId = useMemo(() => `t3-review:${props.threadId}`, [props.threadId]);
  const reviewThreadId = useMemo(() => `review:${props.threadId}`, [props.threadId]);
  const { agent, isReady } = useAgent({
    agentId: localAgentId,
    runtimeAgentId: REVIEW_AGENT_ID,
    threadId: reviewThreadId,
    updates: [...REVIEW_AGENT_UPDATES],
    throttleMs: 75,
  });
  const { copilotkit } = useCopilotKit();
  const renderToolCall = useRenderToolCall();
  const [phase, setPhase] = useState<ReviewPhase>("connecting");
  const [runError, setRunError] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const diffContextRef = useRef<ReviewDiffContext | null>(null);
  const readDiffChunkIndicesRef = useRef(new Set<number>());
  const resultSubmittedRef = useRef(false);
  const automaticRunKeyRef = useRef<string | null>(null);
  const runInFlightRef = useRef(false);

  const agentContext = useMemo(
    () => ({
      project: props.projectName,
      thread: props.threadTitle,
      branch: props.branch,
    }),
    [props.branch, props.projectName, props.threadTitle],
  );
  useAgentContext({
    description: "The active T3 Code project and branch. Inspect the diff before reviewing it.",
    value: agentContext,
  });

  useFrontendTool(
    {
      name: "inspect_branch",
      agentId: localAgentId,
      description:
        "Load the real current branch and working-tree diff from T3 Code. T3 Code invokes this before the review model starts.",
      parameters: z.object({
        reason: z.string().min(1).max(240).describe("Why the branch is being inspected"),
      }),
      handler: async () => {
        setPhase("inspecting");
        const response = await runDiffPreview({
          environmentId: props.environmentId,
          input: { cwd: props.cwd },
        });
        if (response._tag === "Failure") throw new Error("T3 Code could not read the branch diff.");
        const selection = selectCompleteReviewDiffSources(response.value.sources);
        const context = buildReviewDiffContext(selection.sources);
        if (context.summary.truncated) {
          throw new Error(
            "T3 Code could not load the complete diff. The review was stopped instead of reviewing partial changes.",
          );
        }
        diffContextRef.current = context;
        readDiffChunkIndicesRef.current = new Set<number>();
        setScopeNotice(
          selection.workingTreeFallback
            ? "The branch range is too large to load, so this run covers the complete working-tree changes."
            : null,
        );
        setPhase("reviewing");
        return {
          summary: context.summary,
          files: context.files,
          scope: selection.workingTreeFallback ? "working-tree" : "branch-and-working-tree",
          chunks: context.chunks.map(({ diff: _diff, ...chunk }) => chunk),
        };
      },
      render: ({ result, status }) => {
        if (status === "complete") {
          const inspection = reviewInspectionResultSchema.safeParse(parseToolResult(result));
          if (inspection.success) {
            return <ReviewFiles inspection={inspection.data} onOpenFile={props.onOpenFile} />;
          }
        }
        return (
          <ReviewToolStep
            active={status !== "complete"}
            detail={
              status === "complete"
                ? "The changed-file manifest is ready."
                : "Loading the branch range and working-tree changes."
            }
            title={status === "complete" ? "Branch mapped" : "Mapping the branch"}
            tool="inspect_branch"
          />
        );
      },
    },
    [localAgentId, props.cwd, props.environmentId, props.onOpenFile, runDiffPreview],
  );

  useFrontendTool(
    {
      name: "read_review_chunk",
      agentId: localAgentId,
      description:
        "Read one complete chunk from the inspected diff. Read every chunk exactly once, in index order, before submitting the review.",
      parameters: z.object({
        index: z.number().int().positive().describe("The 1-based chunk index from inspect_branch"),
      }),
      handler: async ({ index }) => {
        const context = diffContextRef.current;
        if (context === null) throw new Error("Inspect the branch before reading its diff.");
        const chunk = context.chunks[index - 1];
        if (chunk === undefined || chunk.index !== index) {
          throw new Error(`Review diff chunk ${index} does not exist.`);
        }

        readDiffChunkIndicesRef.current.add(index);
        setPhase("reviewing");
        return {
          ...chunk,
          totalChunks: context.chunks.length,
          remainingChunks: context.chunks
            .filter((candidate) => !readDiffChunkIndicesRef.current.has(candidate.index))
            .map((candidate) => candidate.index),
        };
      },
      render: ({ args, status }) => {
        const index = typeof args.index === "number" ? args.index : null;
        return (
          <ReviewToolStep
            active={status !== "complete"}
            detail={
              index === null
                ? "Preparing the next complete diff chunk."
                : status === "complete"
                  ? `Diff chunk ${index} is now part of the review context.`
                  : `Reading diff chunk ${index}.`
            }
            title={status === "complete" ? "Diff chunk read" : "Reading code changes"}
            tool="read_review_chunk"
          />
        );
      },
    },
    [localAgentId],
  );

  useFrontendTool(
    {
      name: "report_review_progress",
      agentId: localAgentId,
      description:
        "Update T3 Code's native review activity UI before starting a meaningful review pass.",
      parameters: reviewProgressSchema,
      handler: async (next) => {
        const inspectedPaths = new Set(
          diffContextRef.current?.files.map((file) => file.path) ?? [],
        );
        const files = next.files.flatMap((file) => {
          const path = safeWorkspaceRelativePath(file);
          return path !== null && inspectedPaths.has(path) ? [path] : [];
        });
        setPhase("reviewing");
        return { recorded: true, progress: { ...next, files } };
      },
      render: ({ args, result, status }) => {
        const completedProgress =
          status === "complete"
            ? reviewProgressResultSchema.safeParse(parseToolResult(result))
            : null;
        const streamedProgress = reviewProgressSchema.safeParse(args);
        const item = completedProgress?.success
          ? completedProgress.data.progress
          : streamedProgress.success
            ? streamedProgress.data
            : null;
        if (item === null) {
          return (
            <ReviewToolStep
              active={status !== "complete"}
              detail="The agent is preparing its next review pass."
              title="Review pass"
              tool="report_review_progress"
            />
          );
        }
        return (
          <ReviewProgress
            active={status !== "complete"}
            item={item}
            onOpenFile={props.onOpenFile}
          />
        );
      },
    },
    [localAgentId, props.onOpenFile],
  );

  useFrontendTool(
    {
      name: "submit_review",
      agentId: localAgentId,
      description:
        "Finish the review and send the validated findings to T3 Code's native review pane. Call exactly once.",
      parameters: reviewSubmissionSchema,
      handler: async (submission) => {
        const context = diffContextRef.current;
        if (context === null) throw new Error("Inspect the branch before submitting a review.");
        const missingChunks = context.chunks.filter(
          (chunk) => !readDiffChunkIndicesRef.current.has(chunk.index),
        );
        if (missingChunks.length > 0) {
          throw new Error(
            `Read every diff chunk before submitting. Missing: ${missingChunks.map((chunk) => chunk.index).join(", ")}.`,
          );
        }
        const problem = reviewSubmissionProblem(context, submission);
        if (problem !== null) throw new Error(problem);
        const normalizedSubmission: ReviewSubmission = {
          ...submission,
          findings: submission.findings.map((finding) => ({
            ...finding,
            file: safeWorkspaceRelativePath(finding.file)!,
          })),
        };
        resultSubmittedRef.current = true;
        setPhase("complete");
        return { accepted: true, findings: normalizedSubmission.findings.length };
      },
      render: ({ args, result, status }) => {
        const accepted =
          status === "complete"
            ? reviewSubmissionResultSchema.safeParse(parseToolResult(result))
            : null;
        const submission = reviewSubmissionSchema.safeParse(args);
        if (accepted?.success && submission.success) {
          return <ReviewResult onOpenFile={props.onOpenFile} result={submission.data} />;
        }
        return (
          <ReviewToolStep
            active={status !== "complete"}
            detail={
              status === "complete"
                ? "The final review response could not be rendered."
                : "Validating findings and preparing the review result."
            }
            title={status === "complete" ? "Review response received" : "Finalizing review"}
            tool="submit_review"
          />
        );
      },
    },
    [localAgentId, props.onOpenFile],
  );

  const runReview = useCallback(async () => {
    if (!isReady) {
      clearRuntimeError();
      setPhase("connecting");
      copilotkit.connect();
      return;
    }
    if (agent.isRunning || runInFlightRef.current) return;

    runInFlightRef.current = true;
    clearRuntimeError();
    diffContextRef.current = null;
    readDiffChunkIndicesRef.current = new Set<number>();
    resultSubmittedRef.current = false;
    setRunError(null);
    setScopeNotice(null);
    setPhase("inspecting");
    agent.setMessages([]);
    agent.addMessage({
      id: newMessageId(),
      role: "user",
      content:
        "Review the current branch now. T3 Code will attach the diff manifest next. Read every listed chunk, report progress while you work, then submit the final review to the pane.",
    });

    try {
      const inspectionResult = await copilotkit.runTool({
        name: "inspect_branch",
        agentId: localAgentId,
        parameters: { reason: "Start the requested branch review" },
        followUp: false,
      });
      if (inspectionResult.error) throw new Error(inspectionResult.error);
      await copilotkit.runAgent({ agent });
      if (getRuntimeError() !== null) {
        setPhase("error");
        return;
      }
      if (!resultSubmittedRef.current) {
        setRunError("The review stopped before it submitted findings.");
        setPhase("error");
      }
    } catch (error) {
      setRunError(readableReviewError(getRuntimeError() ?? error));
      setPhase("error");
    } finally {
      runInFlightRef.current = false;
    }
  }, [agent, clearRuntimeError, copilotkit, getRuntimeError, isReady, localAgentId]);

  useEffect(() => {
    const automaticRunKey = `${props.threadId}:${props.cwd}:${props.branch ?? "detached"}:${props.reviewRequestId}`;
    if (!isReady || agent.isRunning || automaticRunKeyRef.current === automaticRunKey) return;
    automaticRunKeyRef.current = automaticRunKey;
    void runReview();
  }, [
    agent.isRunning,
    isReady,
    props.branch,
    props.cwd,
    props.reviewRequestId,
    props.threadId,
    runReview,
  ]);

  const toolMessagesByCallId = new Map(
    agent.messages
      .filter((message) => message.role === "tool")
      .map((message) => [message.toolCallId, message] as const),
  );
  const reviewToolCalls = agent.messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []) : [],
  );
  const visibleError = props.runtimeError ? readableReviewError(props.runtimeError) : runError;
  const visiblePhase: ReviewPhase = visibleError === null ? phase : "error";
  const reviewBusy =
    agent.isRunning ||
    visiblePhase === "connecting" ||
    visiblePhase === "inspecting" ||
    visiblePhase === "reviewing";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-start justify-between gap-3 border-b border-border/70 px-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium">Branch review</p>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {props.branch ?? "Detached HEAD"}
          </p>
        </div>
        <Button
          aria-label="Review the latest diff"
          className="shrink-0"
          disabled={reviewBusy}
          onClick={() => void runReview()}
          size={visiblePhase === "complete" ? "sm" : "micro"}
          title={visiblePhase === "complete" ? undefined : "Review again"}
          variant="outline"
        >
          <RefreshCwIcon />
          {visiblePhase === "complete" ? "Redo review" : null}
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div aria-live="polite" className="border-b border-border/70 px-3 py-2.5">
          <ReviewStatus phase={visiblePhase} />
          {scopeNotice ? (
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{scopeNotice}</p>
          ) : null}
        </div>

        <section className="border-b border-border/70 bg-muted/20 px-3 py-3">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-3.5 text-primary" />
            <p className="text-xs font-medium">CopilotKit GenUI</p>
            <Badge size="sm" variant="info">
              Live tool UI
            </Badge>
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
            CopilotKit turns the review agent&apos;s tool calls into the interactive cards below.
          </p>
        </section>

        {visibleError ? (
          <section className="border-b border-border/70 px-3 py-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
              <div>
                <p className="text-sm font-medium">Review could not finish</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{visibleError}</p>
                <Button
                  className="mt-3"
                  onClick={() => void runReview()}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCwIcon />
                  Try again
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        <div aria-label="CopilotKit generated review UI">
          {reviewToolCalls.map((toolCall) => {
            const toolMessage = toolMessagesByCallId.get(toolCall.id);
            return (
              <div key={toolCall.id}>
                {renderToolCall(
                  toolMessage === undefined ? { toolCall } : { toolCall, toolMessage },
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function ReviewUnavailable({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="flex h-full items-start gap-2.5 bg-background px-3 py-4">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export default function CopilotReviewAgent(props: CopilotReviewAgentProps) {
  const preparedConnection = usePreparedConnection(props.environmentId);
  const [runtimeError, setRuntimeError] = useState<Error | null>(null);
  const runtimeErrorRef = useRef<Error | null>(null);
  const runtimeConfig = useMemo(() => {
    if (Option.isNone(preparedConnection)) return null;
    const prepared = preparedConnection.value;
    if (prepared.httpAuthorization?._tag === "Dpop") return "dpop" as const;
    return {
      runtimeUrl: new URL("/api/copilotkit", prepared.httpBaseUrl).toString(),
      headers:
        prepared.httpAuthorization?._tag === "Bearer"
          ? { authorization: `Bearer ${prepared.httpAuthorization.token}` }
          : {},
    };
  }, [preparedConnection]);
  const clearRuntimeError = useCallback(() => {
    runtimeErrorRef.current = null;
    setRuntimeError(null);
  }, []);
  const getRuntimeError = useCallback(() => runtimeErrorRef.current, []);
  const handleRuntimeError = useCallback((error: Error) => {
    runtimeErrorRef.current = error;
    setRuntimeError(error);
  }, []);

  if (runtimeConfig === null) {
    return (
      <ReviewUnavailable
        detail="The review will start when T3 Code reconnects to this environment."
        title="Connecting to the environment"
      />
    );
  }
  if (runtimeConfig === "dpop") {
    return (
      <ReviewUnavailable
        detail="The CopilotKit runtime does not support managed relay authentication yet. Use a local or bearer-authenticated environment."
        title="Review is unavailable for this connection"
      />
    );
  }

  return (
    <HeadlessCopilotProvider
      headers={runtimeConfig.headers}
      key={runtimeConfig.runtimeUrl}
      onError={handleRuntimeError}
      runtimeUrl={runtimeConfig.runtimeUrl}
    >
      <ReviewPane
        {...props}
        clearRuntimeError={clearRuntimeError}
        getRuntimeError={getRuntimeError}
        runtimeError={runtimeError}
      />
    </HeadlessCopilotProvider>
  );
}

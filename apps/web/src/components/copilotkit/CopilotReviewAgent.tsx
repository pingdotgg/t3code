import {
  CopilotChat,
  CopilotKit,
  useAgentContext,
  useComponent,
  useConfigureSuggestions,
  useFrontendTool,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  FileCode2Icon,
  GitBranchIcon,
  LoaderCircleIcon,
  PlayIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { z } from "zod";

import { newMessageId } from "~/lib/utils";
import { reviewEnvironment } from "~/state/review";
import { usePreparedConnection } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { toastManager } from "../ui/toast";
import {
  buildApprovedFixPrompt,
  buildReviewDiffContext,
  reviewApprovalSignature,
  safeWorkspaceRelativePath,
  type ReviewFinding,
} from "./copilotReview.logic";

const REVIEW_AGENT_ID = "review";

const severitySchema = z.enum(["critical", "high", "medium", "low"]);
const findingSchema = z.object({
  id: z.string().min(1),
  severity: severitySchema,
  title: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  explanation: z.string().min(1),
  suggestedFix: z.string().min(1),
});
const reviewDashboardSchema = z.object({
  verdict: z.enum(["ready", "needs-work", "blocked"]),
  summary: z.string().min(1),
  changedFiles: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  checks: z.array(
    z.object({
      label: z.string().min(1),
      status: z.enum(["pass", "warn", "fail"]),
      detail: z.string().min(1),
    }),
  ),
  findings: z.array(findingSchema),
});
const approvalSchema = z.object({
  findings: z.array(findingSchema).min(1),
  verification: z.array(z.string().min(1)).default([]),
});

type ReviewDashboardProps = z.infer<typeof reviewDashboardSchema>;

export interface CopilotReviewAgentProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly projectName: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly isWorking: boolean;
  readonly onOpenFile: (relativePath: string) => void;
}

function failureMessage(result: {
  readonly _tag: "Failure";
  readonly cause: Cause.Cause<unknown>;
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function verdictPresentation(verdict: ReviewDashboardProps["verdict"]) {
  switch (verdict) {
    case "ready":
      return { label: "Ready", variant: "success" as const, icon: CheckCircle2Icon };
    case "blocked":
      return { label: "Blocked", variant: "error" as const, icon: XCircleIcon };
    case "needs-work":
      return { label: "Needs work", variant: "warning" as const, icon: AlertTriangleIcon };
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

function ReviewDashboard({
  verdict,
  summary,
  changedFiles,
  additions,
  deletions,
  checks,
  findings,
  onOpenFile,
}: ReviewDashboardProps & { readonly onOpenFile: (relativePath: string) => void }) {
  const presentation = verdictPresentation(verdict);
  const VerdictIcon = presentation.icon;

  return (
    <Card className="my-3 overflow-hidden rounded-xl border-border/80 bg-card/80">
      <CardHeader className="gap-3 border-b border-border/70 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Branch review
            </p>
            <CardTitle className="text-base leading-5">{summary}</CardTitle>
          </div>
          <Badge variant={presentation.variant}>
            <VerdictIcon />
            {presentation.label}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{changedFiles} files</span>
          <span className="text-success-foreground">+{additions}</span>
          <span className="text-destructive-foreground">-{deletions}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {checks.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {checks.map((check) => (
              <div
                className="rounded-lg border border-border/70 bg-muted/30 p-2.5"
                key={check.label}
              >
                <div className="flex items-center gap-2 text-xs font-medium">
                  {check.status === "pass" ? (
                    <CheckCircle2Icon className="size-3.5 text-success-foreground" />
                  ) : check.status === "fail" ? (
                    <XCircleIcon className="size-3.5 text-destructive-foreground" />
                  ) : (
                    <CircleDotIcon className="size-3.5 text-warning-foreground" />
                  )}
                  {check.label}
                </div>
                <p className="mt-1 text-xs leading-4 text-muted-foreground">{check.detail}</p>
              </div>
            ))}
          </div>
        ) : null}

        {findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg bg-success/8 p-3 text-sm text-success-foreground">
            <ShieldCheckIcon className="size-4" />
            No actionable issue found in the supplied diff.
          </div>
        ) : (
          <div className="space-y-2">
            {findings.map((finding) => {
              const path = safeWorkspaceRelativePath(finding.file);
              return (
                <div className="rounded-lg border border-border/70 p-3" key={finding.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge size="sm" variant={severityVariant(finding.severity)}>
                          {finding.severity}
                        </Badge>
                        <span className="text-sm font-medium">{finding.title}</span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        {finding.explanation}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <code className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {finding.file}
                      {finding.line ? `:${finding.line}` : ""}
                    </code>
                    <Button
                      disabled={path === null}
                      onClick={() => path && onOpenFile(path)}
                      size="micro"
                      variant="outline"
                    >
                      <FileCode2Icon />
                      Open
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToolProgressCard({
  icon: Icon,
  title,
  detail,
  active,
}: {
  readonly icon: typeof GitBranchIcon;
  readonly title: string;
  readonly detail: string;
  readonly active: boolean;
}) {
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 p-3">
      {active ? (
        <LoaderCircleIcon className="size-4 animate-spin text-primary" />
      ) : (
        <Icon className="size-4 text-primary" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function ReviewToolHost(props: CopilotReviewAgentProps) {
  const runDiffPreview = useAtomQueryRunner(reviewEnvironment.diffPreview, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const approvedSignatures = useRef(new Set<string>());
  const openFile = useCallback(
    (relativePath: string) => {
      props.onOpenFile(relativePath);
    },
    [props.onOpenFile],
  );
  const agentContext = useMemo(
    () => ({
      project: props.projectName,
      thread: props.threadTitle,
      branch: props.branch,
      codingAgentBusy: props.isWorking,
    }),
    [props.branch, props.isWorking, props.projectName, props.threadTitle],
  );

  useAgentContext({
    description:
      "The active T3 Code workspace and thread. Use tools to inspect code; do not guess.",
    value: agentContext,
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Review this branch",
        message: "Review the current branch and show me the review dashboard.",
      },
      {
        title: "Find risky changes",
        message: "Inspect this branch and focus the review on correctness and security risks.",
      },
    ],
    available: "before-first-message",
    consumerAgentId: REVIEW_AGENT_ID,
  });

  useFrontendTool(
    {
      name: "inspect_branch",
      agentId: REVIEW_AGENT_ID,
      description:
        "Read the real current branch and working-tree diff from T3 Code. Call this before reviewing or re-reviewing.",
      parameters: z.object({
        reason: z.string().describe("Why the branch needs inspection"),
      }),
      handler: async () => {
        const result = await runDiffPreview({
          environmentId: props.environmentId,
          input: { cwd: props.cwd },
        });
        if (result._tag === "Failure") throw new Error(failureMessage(result));
        return buildReviewDiffContext(result.value.sources);
      },
      render: ({ status, result }) => {
        if (status !== "complete") {
          return (
            <ToolProgressCard
              active
              detail="Reading the branch range and working tree"
              icon={GitBranchIcon}
              title="Inspecting the current diff"
            />
          );
        }
        const parsed = z
          .object({
            summary: z.object({
              changedFiles: z.number(),
              additions: z.number(),
              deletions: z.number(),
              truncated: z.boolean(),
            }),
          })
          .safeParse(parseJson(result));
        const summary = parsed.success ? parsed.data.summary : null;
        return (
          <ToolProgressCard
            active={false}
            detail={
              summary
                ? `${summary.changedFiles} files, +${summary.additions} -${summary.deletions}${summary.truncated ? ", context clipped" : ""}`
                : "Diff loaded"
            }
            icon={GitBranchIcon}
            title="Current diff loaded"
          />
        );
      },
    },
    [props.cwd, props.environmentId, runDiffPreview],
  );

  useComponent(
    {
      name: "present_review_dashboard",
      agentId: REVIEW_AGENT_ID,
      description:
        "Render the branch review as an interactive dashboard after inspect_branch returns. Do not invent CI results.",
      parameters: reviewDashboardSchema,
      render: (dashboardProps) => {
        const parsed = reviewDashboardSchema.safeParse(dashboardProps);
        return parsed.success ? (
          <ReviewDashboard {...parsed.data} onOpenFile={openFile} />
        ) : (
          <ToolProgressCard
            active
            detail="Building the findings and checks"
            icon={GitBranchIcon}
            title="Preparing the review dashboard"
          />
        );
      },
    },
    [openFile],
  );

  useFrontendTool(
    {
      name: "open_file",
      agentId: REVIEW_AGENT_ID,
      description: "Open a repository-relative file in T3 Code's real file viewer.",
      parameters: z.object({
        path: z.string().describe("Repository-relative file path from the inspected diff"),
      }),
      handler: async ({ path }) => {
        const safePath = safeWorkspaceRelativePath(path);
        if (safePath === null)
          throw new Error("Only safe repository-relative paths can be opened.");
        openFile(safePath);
        return { opened: true, path: safePath };
      },
      render: ({ status, args }) => (
        <ToolProgressCard
          active={status !== "complete"}
          detail={args.path ?? "Resolving path"}
          icon={FileCode2Icon}
          title={status === "complete" ? "Opened in T3 Code" : "Opening file"}
        />
      ),
    },
    [openFile],
  );

  useHumanInTheLoop(
    {
      name: "approve_fixes",
      agentId: REVIEW_AGENT_ID,
      description:
        "Ask the user to approve the exact review findings before any coding work begins.",
      parameters: approvalSchema,
      render: ({ status, args, result, respond }) => {
        const findings = args.findings ?? [];
        const verification = args.verification ?? [];
        const signature = reviewApprovalSignature(findings, verification);
        const completedResult =
          status === "complete"
            ? z
                .object({ approved: z.boolean(), count: z.number().optional() })
                .safeParse(parseJson(result))
            : null;

        if (completedResult?.success) {
          return (
            <ToolProgressCard
              active={false}
              detail={
                completedResult.data.approved
                  ? `${completedResult.data.count ?? findings.length} findings approved`
                  : "No code changes were started"
              }
              icon={completedResult.data.approved ? ShieldCheckIcon : XCircleIcon}
              title={completedResult.data.approved ? "Fixes approved" : "Fixes declined"}
            />
          );
        }

        return (
          <Card className="my-3 mb-36 rounded-xl border-primary/30 bg-primary/4 md:mb-3">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheckIcon className="size-4 text-primary" />
                Apply {findings.length} review {findings.length === 1 ? "fix" : "fixes"}?
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-2">
              <div className="space-y-1.5">
                {findings.map((finding) => (
                  <div className="flex items-start gap-2 text-xs" key={finding.id}>
                    <Badge size="sm" variant={severityVariant(finding.severity)}>
                      {finding.severity}
                    </Badge>
                    <span className="leading-4">{finding.title}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs leading-4 text-muted-foreground">
                Approval sends these exact findings to the coding agent in this T3 thread. You can
                still review every edit before committing.
              </p>
              {verification.length > 0 ? (
                <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5">
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Verification
                  </p>
                  {verification.map((command) => (
                    <code className="block break-all text-[11px]" key={command}>
                      {command}
                    </code>
                  ))}
                </div>
              ) : null}
              <div className="flex gap-2">
                <Button
                  disabled={status !== "executing" || !respond || findings.length === 0}
                  onClick={() => {
                    if (!respond) return;
                    approvedSignatures.current.add(signature);
                    void respond({ approved: true, count: findings.length });
                  }}
                  size="sm"
                >
                  <PlayIcon />
                  Approve fixes
                </Button>
                <Button
                  disabled={status !== "executing" || !respond}
                  onClick={() => {
                    if (!respond) return;
                    approvedSignatures.current.delete(signature);
                    void respond({ approved: false });
                  }}
                  size="sm"
                  variant="outline"
                >
                  Not now
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      },
    },
    [],
  );

  useFrontendTool(
    {
      name: "apply_review_fixes",
      agentId: REVIEW_AGENT_ID,
      description:
        "Start the normal T3 Code coding agent with findings that the user just approved. Never call before approve_fixes succeeds.",
      parameters: approvalSchema,
      handler: async ({ findings, verification }) => {
        const signature = reviewApprovalSignature(findings, verification);
        if (!approvedSignatures.current.delete(signature)) {
          throw new Error("These exact findings have not been approved by the user.");
        }
        if (props.isWorking) {
          approvedSignatures.current.add(signature);
          return {
            started: false,
            detail: "The T3 coding agent is already working. Wait for the current turn to finish.",
          };
        }

        const startResult = await startThreadTurn({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: buildApprovedFixPrompt(findings, verification),
              attachments: [],
            },
            modelSelection: props.modelSelection,
            titleSeed: props.threadTitle || "Copilot review fixes",
            runtimeMode: props.runtimeMode,
            interactionMode: props.interactionMode,
            createdAt: new Date().toISOString(),
          },
        });
        if (startResult._tag === "Failure") {
          approvedSignatures.current.add(signature);
          throw new Error(failureMessage(startResult));
        }

        toastManager.add({
          type: "success",
          title: "Approved fixes sent to T3 Code",
          description: `${findings.length} ${findings.length === 1 ? "finding" : "findings"} handed to the coding agent.`,
        });
        return {
          started: true,
          count: findings.length,
          detail: "The coding agent is now implementing the approved fixes in this thread.",
        };
      },
      render: ({ status, result }) => {
        const parsed =
          status === "complete"
            ? z
                .object({ started: z.boolean(), count: z.number().optional(), detail: z.string() })
                .safeParse(parseJson(result))
            : null;
        return (
          <ToolProgressCard
            active={status !== "complete"}
            detail={parsed?.success ? parsed.data.detail : "Preparing the approved handoff"}
            icon={PlayIcon}
            title={
              parsed?.success && !parsed.data.started
                ? "Coding agent is busy"
                : status === "complete"
                  ? "T3 Code is implementing the fixes"
                  : "Starting the coding agent"
            }
          />
        );
      },
    },
    [
      props.environmentId,
      props.interactionMode,
      props.isWorking,
      props.modelSelection,
      props.runtimeMode,
      props.threadId,
      props.threadTitle,
      startThreadTurn,
    ],
  );

  return (
    <CopilotChat
      agentId={REVIEW_AGENT_ID}
      className="min-h-0 bg-background"
      labels={{
        chatInputPlaceholder: "Review this branch or ask about a finding…",
        welcomeMessageText:
          "I can inspect the current diff, render a review, open files, and hand approved fixes to T3 Code.",
      }}
      threadId={`review:${props.threadId}`}
    />
  );
}

export default function CopilotReviewAgent(props: CopilotReviewAgentProps) {
  const preparedConnection = usePreparedConnection(props.environmentId);
  const runtimeConfig = useMemo(() => {
    if (Option.isNone(preparedConnection)) return null;
    const prepared = preparedConnection.value;
    if (prepared.httpAuthorization?._tag === "Dpop") return null;
    return {
      runtimeUrl: new URL("/api/copilotkit", prepared.httpBaseUrl).toString(),
      headers:
        prepared.httpAuthorization?._tag === "Bearer"
          ? { authorization: `Bearer ${prepared.httpAuthorization.token}` }
          : null,
    };
  }, [preparedConnection]);

  if (runtimeConfig === null) return null;

  return (
    <CopilotKit
      credentials="include"
      defaultThrottleMs={75}
      {...(runtimeConfig.headers ? { headers: runtimeConfig.headers } : {})}
      runtimeUrl={runtimeConfig.runtimeUrl}
      showDevConsole={false}
    >
      <ReviewToolHost {...props} />
    </CopilotKit>
  );
}

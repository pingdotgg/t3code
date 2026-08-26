/**
 * A report, read as a brief. The lede sits under the title as its own gist,
 * the argument (Problem, Impact, Solution) stays open because that is what a
 * decision needs, and the proof folds beneath it.
 *
 * The three layers below the argument are deliberately distinct:
 *   Evidence  — the signals that triggered the report. Primary source.
 *   Code      — what the agent read, as pointers with excerpts on demand.
 *   Research  — the agent's own notes about investigating. Lowest trust,
 *               highest volume; folded and last.
 *
 * Every judgment carries the sentence that justifies it, one hover away.
 */
import type {
  EnvironmentId,
  PostHogReport,
  PostHogReportArtefact,
  PostHogSignal,
} from "@t3tools/contracts";
import {
  ChartLineIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CodeIcon,
  FileTextIcon,
  NotebookPenIcon,
  LightbulbIcon,
  SearchIcon,
  TargetIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";

import { cn } from "../../lib/utils";
import { sourceProductLabel } from "../inbox/inboxList.logic";
import ChatMarkdown from "../ChatMarkdown";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readReportArtefacts, type ReportArtefactView } from "./reportArtefacts";
import { splitReportSummary } from "./reportVerdict";

/** A quiet titled section. Collapsible ones start folded unless told otherwise. */
function Section({
  icon: Icon,
  title,
  count,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  readonly icon: ComponentType<{ readonly className?: string }>;
  readonly title: string;
  readonly count?: number;
  readonly collapsible?: boolean;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = collapsible ? open : true;

  const heading = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-medium">{title}</span>
      {count !== undefined ? (
        <span className="tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </>
  );

  return (
    <section className="mt-6 first:mt-0">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setOpen((value) => !value)}
          className="-ms-1 flex w-full items-center gap-2 rounded-[var(--control-radius)] px-1 py-1 text-sm text-foreground/90 hover:text-foreground"
        >
          {heading}
          <ChevronRightIcon
            className={cn(
              "ms-auto size-3.5 text-muted-foreground transition-transform",
              isOpen && "rotate-90",
            )}
          />
        </button>
      ) : (
        <h2 className="flex items-center gap-2 px-1 py-1 text-sm text-foreground/90">{heading}</h2>
      )}
      {isOpen ? <div className="mt-2">{children}</div> : null}
    </section>
  );
}

/** Section titles the agent writes are known prose slots; give each its own mark. */
function slotIcon(title: string): ComponentType<{ readonly className?: string }> {
  const normalized = title.toLowerCase();
  if (normalized.includes("problem")) return TriangleAlertIcon;
  if (normalized.includes("impact")) return TrendingUpIcon;
  if (normalized.includes("solution") || normalized.includes("recommend")) return LightbulbIcon;
  if (normalized.includes("chart")) return ChartLineIcon;
  return TargetIcon;
}

const PROSE_CLASS = "text-sm leading-relaxed [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2";

function Prose({ text }: { readonly text: string }) {
  return <ChatMarkdown text={text} cwd={undefined} className={PROSE_CLASS} />;
}

function SignalCard({ signal }: { readonly signal: PostHogSignal }) {
  const source = [sourceProductLabel(signal.source_product), signal.source_type.replace(/_/g, " ")]
    .filter((part) => part.length > 0)
    .join(" · ");
  return (
    <li className="rounded-md border border-border/70 bg-card/60 p-3">
      {source ? <p className="mb-1 text-xs font-medium text-muted-foreground">{source}</p> : null}
      <div className="text-sm text-foreground/90">
        <ChatMarkdown text={signal.content} cwd={undefined} className={PROSE_CLASS} />
      </div>
    </li>
  );
}

function CodeReference({
  value,
}: {
  readonly value: ReportArtefactView["codeReferences"][number]["value"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-border/70 bg-card/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start gap-2 p-2.5 text-start"
      >
        <ChevronRightIcon
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">
            {value.file_path}
            <span className="text-muted-foreground">
              :{value.start_line}-{value.end_line}
            </span>
          </span>
          {value.relevance_note ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {value.relevance_note}
            </span>
          ) : null}
        </span>
      </button>
      {open && value.contents ? (
        <pre className="overflow-x-auto border-t border-border/70 p-2.5 text-xs leading-relaxed">
          {value.contents}
        </pre>
      ) : null}
    </li>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * Who is on the hook, and why. PostHog's own surfaces drop the reasoning on
 * the grounds that it lives on the pull request — but here the pull request
 * is what has not happened yet, so the report has to carry it.
 */
function Reviewers({ reviewers }: { readonly reviewers: ReportArtefactView["reviewers"] }) {
  return (
    <ul className="flex flex-col gap-2">
      {reviewers.map((reviewer) => {
        const name = reviewer.github_name ?? reviewer.github_login;
        const commit = reviewer.relevant_commits[0];
        const why = commit?.reason ?? reviewer.reason ?? null;
        return (
          <li key={reviewer.github_login} className="flex items-start gap-2.5">
            <span
              aria-hidden
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
            >
              {initials(name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                {name} <span className="text-muted-foreground">@{reviewer.github_login}</span>
              </p>
              {why ? (
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {commit ? <span className="me-1 font-mono">{commit.sha.slice(0, 7)}</span> : null}
                  {why}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ReportDocument({
  report,
  artefacts,
  signals,
  signalsPending,
  environmentId,
}: {
  readonly report: PostHogReport;
  readonly artefacts: ReadonlyArray<PostHogReportArtefact>;
  readonly signals: ReadonlyArray<PostHogSignal>;
  readonly signalsPending: boolean;
  readonly environmentId: EnvironmentId;
}) {
  void environmentId;
  const view = useMemo(() => readReportArtefacts(artefacts), [artefacts]);
  const summary = useMemo(() => splitReportSummary(report.summary), [report.summary]);
  const expectedSignals = report.signal_count ?? 0;

  return (
    <div>
      {summary.lede ? (
        <div className="text-[15px] leading-relaxed text-foreground/90">
          <ChatMarkdown text={summary.lede} cwd={undefined} className={PROSE_CLASS} />
        </div>
      ) : null}

      {summary.sections.length === 0 && !summary.lede && report.summary ? (
        <Prose text={report.summary} />
      ) : null}

      {/* The argument stays open. Folding Impact and Solution hides exactly
          what a decision is made of. */}
      {summary.sections.map((section) => (
        <Section key={section.title} icon={slotIcon(section.title)} title={section.title}>
          <Prose text={section.body} />
        </Section>
      ))}

      {/* Notes arrive after the report was written and routinely change its
          diagnosis, so they read above the evidence rather than below it. */}
      {view.notes.length > 0 ? (
        <Section icon={NotebookPenIcon} title="Since this was written" count={view.notes.length}>
          <ul className="flex flex-col gap-3">
            {view.notes.map(({ id, value }) => (
              <li key={id} className="border-s-2 border-border ps-3">
                <div className="text-sm leading-relaxed">
                  <ChatMarkdown text={value.note} cwd={undefined} className={PROSE_CLASS} />
                </div>
                {value.author ? (
                  <p className="mt-1 text-xs text-muted-foreground">{value.author}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {expectedSignals > 0 || signals.length > 0 ? (
        <Section
          icon={SearchIcon}
          title="Evidence"
          count={signals.length > 0 ? signals.length : expectedSignals}
          collapsible
          defaultOpen={signals.length > 0 && signals.length <= 3}
        >
          {signals.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {signals.map((signal) => (
                <SignalCard key={signal.signal_id} signal={signal} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {signalsPending ? "Loading the signals…" : "PostHog returned no signals."}
            </p>
          )}
        </Section>
      ) : null}

      {view.codeReferences.length > 0 ? (
        <Section
          icon={CodeIcon}
          title="Code the agent read"
          count={view.codeReferences.length}
          collapsible
          defaultOpen={false}
        >
          <ul className="flex flex-col gap-2">
            {view.codeReferences.map(({ id, value }) => (
              <CodeReference key={id} value={value} />
            ))}
          </ul>
        </Section>
      ) : null}

      {view.reviewers.length > 0 ? (
        <Section
          icon={CircleCheckIcon}
          title="Suggested reviewers"
          count={view.reviewers.length}
          collapsible
          defaultOpen={false}
        >
          <Reviewers reviewers={view.reviewers} />
        </Section>
      ) : null}

      {view.findings.length > 0 ? (
        <Section icon={FileTextIcon} title="How the agent checked" collapsible defaultOpen={false}>
          <ul className="flex flex-col gap-3">
            {view.findings.map(({ id, value: finding }) => (
              <li key={id} className="text-xs leading-relaxed text-muted-foreground">
                <p className="mb-1 text-foreground/80">
                  {finding.verified ? "Verified against code or data." : "Could not be verified."}
                </p>
                {finding.relevant_code_paths.length > 0 ? (
                  <p className="mb-1 font-mono">{finding.relevant_code_paths.join(", ")}</p>
                ) : null}
                {Object.entries(finding.relevant_commit_hashes).map(([hash, note]) => (
                  <p key={hash} className="mb-1">
                    <span className="me-1 font-mono">{hash}</span>
                    {note}
                  </p>
                ))}
                {finding.data_queried ? <p>{finding.data_queried}</p> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** The priority chip's tooltip: why the agent landed on this priority. */
export function PriorityExplanation({
  children,
  explanation,
}: {
  readonly children: React.ReactElement;
  readonly explanation: string | null;
}) {
  if (explanation === null || explanation.trim().length === 0) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom" className="max-w-sm text-xs leading-relaxed">
        {explanation}
      </TooltipPopup>
    </Tooltip>
  );
}

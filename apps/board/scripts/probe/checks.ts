import { checkA, checkI, checkJ } from "./claude.ts";
import { checkB, checkC, checkD, checkE, checkH } from "./delegation.ts";
import { checkF, checkG } from "./files.ts";
import type { ProbeContext } from "./connection.ts";

export interface CheckSpec {
  readonly id: string;
  readonly subject: string;
  /** What breaks later when this check fails. */
  readonly followUp: string;
  readonly run: (ctx: ProbeContext, evidence: (line: string) => void) => Promise<boolean>;
}

export const CHECKS: ReadonlyArray<CheckSpec> = [
  {
    id: "A",
    subject:
      "`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from `~/.claude/settings.json` reaches a T3 Claude thread",
    followUp:
      "B6 (the omp rules and persistent env box in K1's install, and the orchestrator brief) cannot rely on 60% compaction for T3 threads. Set `autoCompactWindow` on the Claude provider instance in the board's setup, or tell the orchestrator brief to hand off before the window fills.",
    run: checkA,
  },
  {
    id: "B",
    subject:
      "`delegate_task` with `isolation: 'worktree'` creates a worktree and a child whose `lineage.parentThreadId` is the parent",
    followUp:
      "B6 (the role registry's `isolation` field) and B7 (agent cards from `lineage.parentThreadId`) must not promise worktree children. Builders then share the project checkout, so B6 serializes builders and B7 groups agents by `delegatedFrom` or the subagent projection instead.",
    run: checkB,
  },
  {
    id: "C",
    subject: "A child can call `delegate_task` itself",
    followUp:
      "B6's orchestrator brief must keep delegation one level deep: owners cannot start their own agents, so the orchestrator spawns every agent and B7 reads a flat family.",
    run: checkC,
  },
  {
    id: "D",
    subject:
      "A child in `approval-required` mode shows a `pendingRuntimeRequest`, and `runtime-request.respond` from the board's connection resolves it",
    followUp:
      "B8's For-you merge cannot show engine approvals from `pendingRuntimeRequest`. Route approvals to the thread view in B7 and drop the approval source from B8.",
    run: checkD,
  },
  {
    id: "E",
    subject: "A child question wakes the parent thread",
    followUp:
      "B8's For-you cards cannot rely on the orchestrator learning of a child question. The board reads `user_input_request` items from the family itself and sends the parent the answer with `t3_thread_send`.",
    run: checkE,
  },
  {
    id: "F",
    subject: "`projects.readFile` and `projects.listEntries` accept an absolute path",
    followUp:
      "B5's `boardFiles.ts` and B9's `store/artifacts.ts` must call `projects.listEntries` with a `directoryPath` relative to the project and never an absolute one, and list a folder outside the project, such as a worktree child's, with that folder as `cwd`. B9's `ArtifactViewer.tsx` reads an absolute path through `projects.readFile` only where the evidence shows that call accepted it.",
    run: checkF,
  },
  {
    id: "G",
    subject:
      "An `assets.createUrl` `media-file` URL for an absolute path loads without an auth header",
    followUp:
      "B9's `ArtifactViewer.tsx` cannot hand the URL to an `<img>` tag. Fetch the image with the bearer and show a blob URL.",
    run: checkG,
  },
  {
    id: "H",
    subject:
      "Archiving a parent leaves its children unarchived, and archiving is refused while a child runs",
    followUp:
      "B5's archive flow cannot assume the engine refuses, or that children stay: stop the family first and archive every thread from `getThreadFamily` explicitly.",
    run: checkH,
  },
  {
    id: "I",
    subject: "A T3 Claude thread writes and later reads Claude Code's own project memory",
    followUp:
      "B6's orchestrator brief and B12's skills cannot lean on Claude Code's project memory for cross-session facts. The brief must write them into the board's store files.",
    run: checkI,
  },
  {
    id: "J",
    subject:
      "A T3 Claude thread can drive a page with the `preview_*` tools while no board or web client is connected",
    followUp:
      "B11's browser panel is the preview host. Agents can use `preview_*` only while the board shows the panel, so the B11 brief and lanes keep the panel open and B12 skills say so.",
    run: checkJ,
  },
];

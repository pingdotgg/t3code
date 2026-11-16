import {
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewTabId,
  QaEvidenceRecordInput,
  QaRun,
  QaRunError,
  QaScenario,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as QaRuns from "../../../qa/QaRuns.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
  QaRuns.QaRuns,
  QaRecorder.QaRecorder,
];

const failure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure, QaRunError]);

const QaEvidenceRecordTool = Tool.make("qa_evidence_record", {
  description:
    "Record one scenario's verdict with evidence. Takes a full screenshot of the tab and saves its console and network logs to this run's evidence folder. Call it once per verdict, right after you observed the result, while the page still shows it. A PASS or FAIL without a screenshot is stored as INCONCLUSIVE. For a FAIL, give `expected`, `actual`, `severity` and `steps` so it reads as a bug report.",
  parameters: Schema.Struct({
    ...QaEvidenceRecordInput.fields,
    tabId: Schema.optional(PreviewTabId),
  }),
  success: QaScenario,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Record QA evidence")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const QaReportFinishTool = Tool.make("qa_report_finish", {
  description:
    "Finish this QA run: stop its video and write report.md and report.html to the run folder. Call it once after your last verdict. The run also finishes on its own when your turn ends.",
  success: Schema.Struct({ run: Schema.NullOr(QaRun) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Finish QA report")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const QaToolkit = Toolkit.make(QaEvidenceRecordTool, QaReportFinishTool);

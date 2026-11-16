import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as QaRuns from "../../../qa/QaRuns.ts";
import { QaToolkit } from "./tools.ts";

const decodePng = (data: string | undefined) =>
  data === undefined || data.length === 0 ? null : new Uint8Array(Buffer.from(data, "base64"));

export const layer = McpToolAccess.toLayer(QaToolkit, {
  qa_evidence_record: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const qaRuns = yield* QaRuns.QaRuns;
      // The full-resolution capture is for people; the capped one is the fallback.
      const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        operation: "snapshot",
        input: { fullScreenshot: true },
        ...(tabId === undefined ? {} : { tabId }),
      });
      return yield* qaRuns.recordEvidence(scope.thread.threadId, input, {
        url: snapshot.url,
        title: snapshot.title,
        png: decodePng(snapshot.fullScreenshot?.data ?? snapshot.screenshot.data),
        consoleEntries: snapshot.consoleEntries,
        networkEntries: snapshot.networkEntries,
        actionTimeline: snapshot.actionTimeline,
      });
    }),
  ),
  qa_report_finish: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const recorder = yield* QaRecorder.QaRecorder;
      return { run: yield* recorder.finish(scope.thread.threadId) };
    }),
  ),
});

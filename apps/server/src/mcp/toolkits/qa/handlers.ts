import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as QaRecorder from "../../../qa/QaRecorder.ts";
import * as QaRuns from "../../../qa/QaRuns.ts";
import { QaToolkit } from "./tools.ts";

// Inline styles, not a <style> tag, so a strict page CSP cannot block the mask.
const MASK_PASSWORDS = `(() => {
  const masked = [];
  for (const input of document.querySelectorAll('input[type="password"]')) {
    masked.push([input, input.getAttribute("style")]);
    input.style.setProperty("color", "transparent", "important");
    input.style.setProperty("text-shadow", "none", "important");
    input.style.setProperty("-webkit-text-security", "none", "important");
  }
  globalThis.__exploroQaPasswordMask = masked;
  return masked.length;
})()`;
const UNMASK_PASSWORDS = `(() => {
  for (const [input, style] of globalThis.__exploroQaPasswordMask ?? []) {
    if (style === null) input.removeAttribute("style");
    else input.setAttribute("style", style);
  }
  delete globalThis.__exploroQaPasswordMask;
  return true;
})()`;

const decodePng = (data: string | undefined) =>
  data === undefined || data.length === 0 ? null : new Uint8Array(Buffer.from(data, "base64"));

export const layer = McpToolAccess.toLayer(QaToolkit, {
  qa_evidence_record: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const qaRuns = yield* QaRuns.QaRuns;
      const tab = tabId === undefined ? {} : { tabId };
      const evaluate = (expression: string) =>
        broker
          .invoke({ scope, operation: "evaluate", input: { expression, ...tab }, ...tab })
          .pipe(Effect.ignore);
      // Saved evidence outlives the turn, so password fields are blanked, not just dotted.
      // The full-resolution capture is for people; the capped one is the fallback.
      const snapshot = yield* evaluate(MASK_PASSWORDS).pipe(
        Effect.andThen(
          broker.invoke<PreviewAutomationSnapshot>({
            scope,
            operation: "snapshot",
            input: { fullScreenshot: true },
            ...tab,
          }),
        ),
        Effect.ensuring(evaluate(UNMASK_PASSWORDS)),
      );
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

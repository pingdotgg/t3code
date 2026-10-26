import { prepareOffice } from "./officeArchive";
import type { OfficeWorkerRequest, OfficeWorkerResult } from "./officePreviewProtocol";
self.addEventListener("message", (event: MessageEvent<OfficeWorkerRequest>) => {
  if (event.data.type !== "open") return;
  const input = event.data;
  void prepareOffice(input.bytes, input.kind)
    .then((result) => {
      const reply: OfficeWorkerResult = { type: input.kind, ...result };
      self.postMessage(reply, { transfer: [result.bytes] });
    })
    .catch((cause: unknown) => {
      self.postMessage(
        {
          type: "error",
          message: cause instanceof Error ? cause.message : "Could not parse this file.",
        } satisfies OfficeWorkerResult,
        { transfer: [] },
      );
    });
});

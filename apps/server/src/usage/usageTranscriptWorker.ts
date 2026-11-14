import type { UsageProviderKind } from "@t3tools/contracts";

import { TRANSCRIPT_USAGE_FORMATS } from "./usageTranscriptFormats.ts";
import { readTranscriptRecords, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

export interface TranscriptParseRequest {
  readonly path: string;
  readonly provider: UsageProviderKind;
  readonly size: number;
  readonly resumeFrom?: TranscriptParsePosition;
}

const READ_CONCURRENCY = 4;

/** Reads `TranscriptParseRequest[]` JSON on stdin; writes one `[index, result | null]` line per file as it finishes. */
export async function runUsageTranscriptWorker(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const requests: readonly TranscriptParseRequest[] = JSON.parse(input);
  const queue = requests.entries();
  const work = async () => {
    for (const [index, request] of queue) {
      const format = TRANSCRIPT_USAGE_FORMATS.get(request.provider);
      const result =
        format === undefined
          ? null
          : await readTranscriptRecords(request.path, format, request.resumeFrom);
      if (!process.stdout.write(JSON.stringify([index, result]) + "\n")) {
        await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, work));
}

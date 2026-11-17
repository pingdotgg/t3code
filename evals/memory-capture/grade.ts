import type { KnowledgeCandidatesGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import type { CaptureCase } from "./cases.ts";

export function grade(fixture: CaptureCase, result: KnowledgeCandidatesGenerationResult) {
  const failures: string[] = [];
  if (result.candidates.length !== fixture.count)
    failures.push(`Expected ${fixture.count} memories, got ${result.candidates.length}`);
  const content = result.candidates.map((candidate) => candidate.content).join("\n");
  for (const pattern of fixture.mustMention ?? [])
    if (!new RegExp(pattern, "iu").test(content)) failures.push(`Missing: ${pattern}`);
  for (const pattern of fixture.mustNot ?? [])
    if (new RegExp(pattern, "iu").test(content)) failures.push(`Unwanted: ${pattern}`);
  const refs = new Set(fixture.input.messages.map((message) => message.ref));
  for (const candidate of result.candidates) {
    if (candidate.citations.length === 0 || candidate.citations.some((ref) => !refs.has(ref)))
      failures.push("Missing or invented citation");
    if (fixture.citation && !candidate.citations.includes(fixture.citation))
      failures.push(`Missing supporting citation ${fixture.citation}`);
  }
  return failures;
}

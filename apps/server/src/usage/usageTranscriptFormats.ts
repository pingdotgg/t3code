import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { grokUsageFormat } from "@t3tools/provider-grok/server/usage";
import { museUsageFormat } from "@t3tools/provider-muse/server/usage";
import { piUsageFormat } from "@t3tools/provider-pi/server/usage";

import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { codexUsageFormat } from "../provider/Drivers/codexUsage.ts";

/** The parse subprocess loads these directly; the full driver registry takes seconds to import. */
export const TRANSCRIPT_USAGE_FORMATS = new Map<UsageProviderKind, TranscriptUsageFormat<unknown>>([
  ["claude", claudeUsageFormat as TranscriptUsageFormat<unknown>],
  ["codex", codexUsageFormat as TranscriptUsageFormat<unknown>],
  ["grok", grokUsageFormat as TranscriptUsageFormat<unknown>],
  ["muse", museUsageFormat],
  ["pi", piUsageFormat as TranscriptUsageFormat<unknown>],
]);

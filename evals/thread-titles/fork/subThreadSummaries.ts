import type { ThreadTitleMessage } from "@t3tools/provider-core/server/threadTitleContext";

import { SUMMARY_INSTRUCTIONS } from "../../../apps/server/src/fork/subThreads/summaryInstructions.ts";

const source = "Chat mode: the summary line under a first message";

/** Each case is one sub-thread; `previousTitle` is its last summary. */
export const subThreadSummaryCases = [
  {
    id: "sub-thread-summary-english",
    source,
    request: "Replies about a red lint job, inside a chat about a release.",
    previousTitle: "Release branch CI",
    instructions: SUMMARY_INSTRUCTIONS,
    messages: [
      { role: "assistant", text: "CI is red on the release branch. Do you want me to look?" },
      { role: "user", text: "Yes. Why is it red?" },
      {
        role: "assistant",
        text: "The lint job fails on an unused import in the settings page. I removed the import and CI is green again.",
      },
      {
        role: "user",
        text: "Good. Add the lint job to the pre-commit hook so this cannot come back.",
      },
    ],
    rubric: "At most 7 words, in English. Name the lint failure, not the release.",
  },
  {
    id: "sub-thread-summary-chinese",
    source,
    request: "Replies in Chinese about a slow index step of a database migration.",
    previousTitle: "数据库迁移",
    instructions: SUMMARY_INSTRUCTIONS,
    messages: [
      { role: "user", text: "迁移脚本在生产环境跑了多久？" },
      { role: "assistant", text: "大约四十分钟，大部分时间用在给订单表加索引。" },
      { role: "user", text: "太久了。能不能把加索引放到低峰期单独做？" },
    ],
    rubric: "At most 12 Han characters, in Chinese. Name the slow index step of the migration.",
  },
] satisfies ReadonlyArray<{
  id: string;
  source: string;
  request: string;
  previousTitle: string;
  instructions: string;
  messages: ReadonlyArray<ThreadTitleMessage>;
  rubric: string;
}>;

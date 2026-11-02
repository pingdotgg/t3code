/** Diff failures currently include transport wrappers, so recognize the reason inside them. */
import { translateNow } from "../media/translateNow";
export function describePullRequestDiffError(error: string, providerName: string, term: string) {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/i.test(error)) {
    return {
      title: `${providerName} rate limit reached`,
      description: translateNow("review.pr.rateLimited", {
        provider: providerName,
        providerAgain: providerName,
      }),
    };
  }

  return {
    title: translateNow("review.extra.couldn.t.load.the.changes"),
    description: `The environment couldn't load this ${term}'s diff. Try again, or view the changes on ${providerName}.`,
  };
}

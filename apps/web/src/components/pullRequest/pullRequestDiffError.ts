/** Diff failures currently include transport wrappers, so recognize the reason inside them. */
export function describePullRequestDiffError(error: string, providerName: string, term: string) {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/i.test(error)) {
    return {
      title: `${providerName} rate limit reached`,
      description: `${providerName} is temporarily limiting requests, so this diff couldn't be loaded. Try again after the limit resets, or view the changes on ${providerName}.`,
    };
  }

  return {
    title: "Couldn't load the changes",
    description: `The environment couldn't load this ${term}'s diff. Try again, or view the changes on ${providerName}.`,
  };
}

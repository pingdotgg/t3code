type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Build-time constants for `T3CODE_STANDALONE=1` builds, which take releases from the fork
 * and keep the server off T3's model catalog and telemetry. Default builds get none, so their
 * output is unchanged.
 */
export function standaloneBuildDefine(env: Environment): Record<string, string> {
  if (!/^(1|true)$/i.test(env.T3CODE_STANDALONE?.trim() ?? "")) return {};
  // The same chain the desktop update feed uses, so the CLI and the app follow one repository.
  const repository = (
    env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    env.GITHUB_REPOSITORY?.trim() ||
    ""
  ).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(
      "T3CODE_STANDALONE=1 needs T3CODE_DESKTOP_UPDATE_REPOSITORY or GITHUB_REPOSITORY set to the fork's owner/repo.",
    );
  }
  if (repository.toLowerCase().startsWith("pingdotgg/")) {
    throw new Error(
      `T3CODE_STANDALONE=1 does not allow the release repository ${repository}; use the fork's.`,
    );
  }
  const hostedAppUrl = env.T3CODE_HOSTED_APP_URL?.trim();
  return {
    __T3CODE_BUILD_STANDALONE__: "true",
    __T3CODE_BUILD_RELEASE_REPOSITORY__: JSON.stringify(repository),
    // Empty when the fork hosts no web app: nothing then trusts or links to a hosted origin.
    __T3CODE_BUILD_HOSTED_APP_URL__: JSON.stringify(
      hostedAppUrl ? new URL(hostedAppUrl).origin : "",
    ),
  };
}

// Agent shells carry real provider credentials (CLIProxy sets ANTHROPIC_AUTH_TOKEN and
// ANTHROPIC_BASE_URL) and the agent's own T3 state. Tests that read the ambient environment
// then pass or fail by who runs them. Tests that need one of these variables set it
// themselves. Set T3CODE_TEST_KEEP_PROVIDER_ENV=1 to keep them, for example for a live run.
const PROVIDER_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "T3CODE_", "T3_"];

const KEPT_ENV = new Set([
  // Selects the mobile test platform; the Vite config and platform-branched tests must agree on it.
  "T3_MOBILE_TEST_PLATFORM",
  // CI sets these so the transfer budget integration test writes its report for the job summary.
  "T3CODE_TRANSFER_BUDGET_REPORT_PATH",
  "T3CODE_TRANSFER_BUDGET_RESULT_PATH",
  // Opt-in: points the HtmlRender tests at a headless browser, which they skip without.
  "T3CODE_TEST_HEADLESS_SHELL",
  // The mobile test script sets this; tests must see the platform their code was compiled for.
  "T3_MOBILE_TEST_PLATFORM",
]);

if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV !== "1") {
  for (const key of Object.keys(process.env)) {
    if (KEPT_ENV.has(key)) continue;
    if (PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
}

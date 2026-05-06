import type { CheckResult } from "../result";

export type EnvBootstrapAction = "doppler-config" | "github-environment" | "non-secret-copy";

export type EnvBootstrapRequest = {
  action: EnvBootstrapAction;
  target: string;
};

export const describeEnvBootstrap = (request: EnvBootstrapRequest): CheckResult => ({
  id: `env/fix/${request.action}`,
  name: "Environment bootstrap fix",
  status: "info",
  durationMs: 0,
  hint: `Run the guarded bootstrap action for ${request.target}. Secret values are never copied.`,
  fixable: false,
  evidence: {},
});

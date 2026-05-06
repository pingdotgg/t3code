import type { CheckResult } from "./result";
import { createIntegrationChecks } from "./checks/integrations";
import { createStackChecks } from "./checks/stack";
import { createEnvChecks } from "./checks/env";

export type CheckContext = {
  cwd: string;
  timeoutMs: number;
};

export type Check = {
  id: string;
  name: string;
  run: (context: CheckContext) => Promise<CheckResult> | CheckResult;
};

export const createRegistry = (checks: Check[]): Check[] => [...checks];

export const defaultRegistry = createRegistry([
  ...createIntegrationChecks(),
  ...createStackChecks(),
  ...createEnvChecks(),
]);

export function compactDroidEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

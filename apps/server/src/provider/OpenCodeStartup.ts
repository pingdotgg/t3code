/** Credentials and URL can arrive in different stdout chunks. */
export function parse(output: string, configuredPassword?: string) {
  const legacy = /^opencode server listening on (https?:\/\/\S+)/m.exec(output);
  if (legacy?.[1])
    return { url: legacy[1], serverPassword: configuredPassword, apiVersion: 1 as const };
  const url = /^server listening on (https?:\/\/[^\s]+)\r?\n/m.exec(output)?.[1];
  const password = /^server password ([^\r\n]+)(?:\r?\n)/m.exec(output)?.[1] ?? configuredPassword;
  if (!url || !password) return null;
  return { url, serverPassword: password, apiVersion: 2 as const };
}

export function redact(output: string): string {
  return output.replace(/(server password\s+)[^\r\n]*/g, "$1[REDACTED]");
}

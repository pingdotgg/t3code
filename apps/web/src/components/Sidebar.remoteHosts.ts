import { RemoteHostId, type RemoteHostRecord, type RemoteHostUpsertInput } from "@t3tools/contracts";

export const DEFAULT_REMOTE_HELPER_COMMAND = "t3 remote-agent --stdio";
export const REMOTE_HOSTS_QUERY_KEY = ["remote-hosts"] as const;
export const REMOTE_BROWSE_LIMIT = 40;

export interface RemoteHostDraft {
  id: RemoteHostId | null;
  label: string;
  host: string;
  port: string;
  user: string;
  identityFile: string;
  sshConfigHost: string;
  helperCommand: string;
}

export function emptyRemoteHostDraft(): RemoteHostDraft {
  return {
    id: null,
    label: "",
    host: "",
    port: "22",
    user: "",
    identityFile: "",
    sshConfigHost: "",
    helperCommand: DEFAULT_REMOTE_HELPER_COMMAND,
  };
}

export function draftFromRemoteHost(host: RemoteHostRecord): RemoteHostDraft {
  return {
    id: host.id,
    label: host.label,
    host: host.host,
    port: String(host.port),
    user: host.user,
    identityFile: host.identityFile ?? "",
    sshConfigHost: host.sshConfigHost ?? "",
    helperCommand: host.helperCommand,
  };
}

export function normalizeRemoteHostDraft(draft: RemoteHostDraft) {
  return {
    id: draft.id,
    label: draft.label.trim(),
    host: draft.host.trim(),
    port: draft.port.trim(),
    user: draft.user.trim(),
    identityFile: draft.identityFile.trim(),
    sshConfigHost: draft.sshConfigHost.trim(),
    helperCommand: draft.helperCommand.trim(),
  };
}

function normalizeRemoteHostRecord(host: RemoteHostRecord) {
  return {
    id: host.id,
    label: host.label.trim(),
    host: host.host.trim(),
    port: String(host.port),
    user: host.user.trim(),
    identityFile: (host.identityFile ?? "").trim(),
    sshConfigHost: (host.sshConfigHost ?? "").trim(),
    helperCommand: host.helperCommand.trim(),
  };
}

export function doesRemoteHostDraftMatchRecord(
  draft: RemoteHostDraft,
  host: RemoteHostRecord | null,
): boolean {
  if (!host || draft.id !== host.id) {
    return false;
  }

  const normalizedDraft = normalizeRemoteHostDraft(draft);
  const normalizedHost = normalizeRemoteHostRecord(host);

  return (
    normalizedDraft.label === normalizedHost.label &&
    normalizedDraft.host === normalizedHost.host &&
    normalizedDraft.port === normalizedHost.port &&
    normalizedDraft.user === normalizedHost.user &&
    normalizedDraft.identityFile === normalizedHost.identityFile &&
    normalizedDraft.sshConfigHost === normalizedHost.sshConfigHost &&
    normalizedDraft.helperCommand === normalizedHost.helperCommand
  );
}

export function formatRemoteHostSummary(host: RemoteHostRecord): string {
  return `${host.user}@${host.host}${host.port === 22 ? "" : `:${host.port}`}`;
}

export function remoteHostSelectItems(remoteHosts: readonly RemoteHostRecord[]) {
  return Object.fromEntries(
    remoteHosts.map((host) => [host.id, `${host.label} (${formatRemoteHostSummary(host)})`]),
  );
}

export function remoteHostDraftToUpsertInput(draft: RemoteHostDraft): RemoteHostUpsertInput {
  const normalizedDraft = normalizeRemoteHostDraft(draft);
  const port = Number.parseInt(normalizedDraft.port, 10);

  if (
    normalizedDraft.label.length === 0 ||
    normalizedDraft.host.length === 0 ||
    normalizedDraft.user.length === 0
  ) {
    throw new Error("Label, host, and user are required.");
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Port must be a positive integer.");
  }

  return {
    id: normalizedDraft.id ?? RemoteHostId.makeUnsafe(crypto.randomUUID()),
    label: normalizedDraft.label,
    host: normalizedDraft.host,
    port,
    user: normalizedDraft.user,
    ...(normalizedDraft.identityFile ? { identityFile: normalizedDraft.identityFile } : {}),
    ...(normalizedDraft.sshConfigHost ? { sshConfigHost: normalizedDraft.sshConfigHost } : {}),
    ...(normalizedDraft.helperCommand ? { helperCommand: normalizedDraft.helperCommand } : {}),
  };
}

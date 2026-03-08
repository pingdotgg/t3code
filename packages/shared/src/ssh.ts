import type { RemoteHostRecord } from "@t3tools/contracts";

export function formatRemoteHostIdentity(host: Pick<RemoteHostRecord, "user" | "host">): string {
  return `${host.user}@${host.host}`;
}

export function formatRemoteHostLabel(
  host: Pick<RemoteHostRecord, "label" | "user" | "host">,
): string {
  const label = host.label.trim();
  if (label.length > 0) {
    return label;
  }
  return formatRemoteHostIdentity(host);
}

export function resolveSshDestination(
  host: Pick<RemoteHostRecord, "user" | "host" | "sshConfigHost">,
): string {
  if (host.sshConfigHost && host.sshConfigHost.trim().length > 0) {
    return host.sshConfigHost.trim();
  }
  return `${host.user}@${host.host}`;
}

export function buildSshArgs(
  host: Pick<
    RemoteHostRecord,
    "port" | "identityFile" | "user" | "host" | "sshConfigHost"
  >,
  remoteCommand?: string,
): string[] {
  const args: string[] = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if (host.port !== 22) {
    args.push("-p", String(host.port));
  }
  if (host.identityFile && host.identityFile.trim().length > 0) {
    args.push("-o", "IdentitiesOnly=yes");
    args.push("-i", host.identityFile.trim());
  }
  args.push(resolveSshDestination(host));
  if (remoteCommand && remoteCommand.trim().length > 0) {
    args.push(remoteCommand);
  }
  return args;
}

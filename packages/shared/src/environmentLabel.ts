// WSL inherits the Windows hostname; distinguish the environments on every client.
export function wslEnvironmentLabel(hostname: string, distro: string | null): string {
  return distro ? `${hostname} WSL (${distro})` : `${hostname} WSL`;
}

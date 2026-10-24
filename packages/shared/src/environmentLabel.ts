// WSL mirrors the Windows computer name into its hostname, so a WSL server
// and its Windows host need the distro in the label to tell them apart. The
// server and the desktop app both label WSL environments with this, so the
// host and remote clients show the same name.
export function wslEnvironmentLabel(hostname: string, distro: string | null): string {
  return distro ? `${hostname} WSL (${distro})` : `${hostname} WSL`;
}

interface DiscordPresenceThread {
  readonly environmentId: string;
  readonly projectId: string;
  readonly session: { readonly status: string } | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
}

export function countActiveDiscordPresenceProjects(
  threads: ReadonlyArray<DiscordPresenceThread>,
): number {
  const activeProjects = new Set<string>();
  for (const thread of threads) {
    const isWorking =
      thread.session?.status === "starting" ||
      thread.session?.status === "running" ||
      thread.backgroundLiveness === "working";
    if (isWorking) {
      activeProjects.add(`${thread.environmentId}\0${thread.projectId}`);
    }
  }
  return activeProjects.size;
}

import type { StoredGitHubEvent } from "./event-log.ts";

export function formatSseEvent(event: StoredGitHubEvent): string {
  return `id: ${event.sequence}\nevent: github\ndata: ${JSON.stringify(event)}\n\n`;
}

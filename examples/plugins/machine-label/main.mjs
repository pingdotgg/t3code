// Shows a configurable label in the status area of each thread that finishes a turn,
// so threads from different machines are easy to tell apart. Settings are read on
// every turn, so a change shows on the next one.
import * as NodeOS from "node:os";

// A plugin shows at most 16 statuses at once, so only the most recent threads keep a label.
const MAX_LABELED_THREADS = 16;
const KEY = "machine";

export function activate(context) {
  const { onEvent, settings, status } = context.proposed;
  const labeled = new Set();
  onEvent(async (event) => {
    if (event.type !== "run.finalized") return;
    const label = (await settings.get("label")) || NodeOS.hostname();
    const tone = await settings.get("tone");
    labeled.delete(event.threadId);
    labeled.add(event.threadId);
    try {
      if (labeled.size > MAX_LABELED_THREADS) {
        const [oldest] = labeled;
        labeled.delete(oldest);
        await status.clear({ threadId: oldest, key: KEY });
      }
      await status.set({ threadId: event.threadId, key: KEY, text: label, tone });
    } catch (error) {
      // Status updates are rate limited. Skip this one instead of throwing, which would
      // fail the page and deliver the same events again.
      context.log.warn(`Skipped a label: ${error.message}`);
    }
  });
}

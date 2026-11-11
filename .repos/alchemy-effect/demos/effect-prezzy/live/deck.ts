import { deck, loopDeck } from "../deck.ts";
import { schedule } from "../remotion/scene/schedule.ts";
import { introTimeline, type IntroJson } from "../shared/intro.ts";
import { VIDEO, type DeckItem, type SceneCapture } from "../shared/types.ts";

/** One deck item, loaded and ready for a <Player>. */
export interface LiveItem {
  item: DeckItem;
  durationInFrames: number;
  inputProps: Record<string, unknown>;
}

/** One press of →: frames `[from, to)` of an item. */
export interface LiveStep {
  item: number;
  from: number;
  to: number;
  title: string;
  notes: string;
}

const fetchJson = async <T>(file: string): Promise<T | undefined> => {
  const response = await fetch(`/${file}?t=${Date.now()}`);
  return response.ok ? ((await response.json()) as T) : undefined;
};

/**
 * Clip times where the recorded terminal starts printing again after at least
 * 1.5s of silence: natural places to stop and talk (e.g. a plan waiting for approval).
 */
const terminalPauses = async (id: string): Promise<number[]> => {
  const response = await fetch(`/${id}/terminal.cast?t=${Date.now()}`);
  if (!response.ok) return [];
  const pauses: number[] = [];
  let previous = 0;
  for (const line of (await response.text()).split("\n").slice(1)) {
    if (!line.startsWith("[")) continue;
    const [time] = JSON.parse(line) as [number];
    if (time - previous > 1.5) pauses.push(time);
    previous = time;
  }
  return pauses;
};

/**
 * Loads every deck item the same way render.ts does, splits it into
 * presenter steps, and skips scenes that haven't been captured yet.
 */
export const loadDeck = async (name = "loop") => {
  const items: LiveItem[] = [];
  const steps: LiveStep[] = [];
  for (const item of name === "talk" ? deck : loopDeck) {
    const index = items.length;
    if (item.kind === "slide") {
      const frames = Math.round((item.seconds ?? 2) * VIDEO.fps);
      items.push({
        item,
        durationInFrames: frames,
        inputProps: { layout: item.layout, props: item.props },
      });
      steps.push({ item: index, from: 0, to: frames, title: item.title, notes: item.notes });
    } else if (item.kind === "intro") {
      const intro = await fetchJson<IntroJson>(`${item.id}/intro.json`);
      if (!intro) continue;
      const ranges = introTimeline(intro.steps);
      items.push({
        item,
        durationInFrames: Math.max(1, ranges.at(-1)?.to ?? 1),
        inputProps: { intro, source: item.id },
      });
      ranges.forEach((range, k) =>
        steps.push({
          item: index,
          ...range,
          title: intro.steps[k]!.title,
          notes: intro.steps[k]!.notes,
        }),
      );
    } else {
      const capture = await fetchJson<SceneCapture>(`${item.id}/scene.json`);
      if (!capture) continue;
      if (capture.terminal) capture.terminal.pauses ??= await terminalPauses(item.id);
      const plan = await schedule(capture, VIDEO.fps);
      items.push({
        item,
        durationInFrames: plan.durationInFrames,
        inputProps: { id: item.id, capture, plan },
      });
      for (const step of plan.steps) steps.push({ item: index, ...step });
    }
  }
  return { items, steps };
};

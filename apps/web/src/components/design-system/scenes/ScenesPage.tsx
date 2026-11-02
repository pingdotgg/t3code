import type { ProviderApprovalDecision } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useTheme } from "../../../hooks/useTheme";
import { Button } from "../../ui/button";
import { Text } from "../../ui/text";
import { playbackComposerRequests, playSteps, requestStepKey, type Step } from "./playback";
import { PlaybackComposer } from "./PlaybackComposer";
import { PlaybackTimeline } from "./PlaybackTimeline";
import { addableSteps, turnScripts, type TurnScript } from "./turnScripts";

const PLAY_INTERVAL_MS = 700;

/**
 * One screen for driving the real timeline through a turn. The sidebar picks
 * the script (`?script=`); step, scrub or play it here, and while a turn runs
 * add tool calls or end it by hand. Every state is contract items through the
 * wire projection, so what shows is what a connected client would show.
 */
export function ScenesPage({ scriptId }: { scriptId: string | undefined }) {
  const script = turnScripts.find((entry) => entry.id === scriptId) ?? turnScripts[0]!;
  // A new script starts over: fresh steps, cursor and timeline.
  return <TurnPlayer key={script.id} script={script} />;
}

function TurnPlayer({ script }: { script: TurnScript }) {
  const { resolvedTheme } = useTheme();
  const [steps, setSteps] = useState<ReadonlyArray<Step>>(script.steps);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [added, setAdded] = useState(0);

  // Playing is a derived flag: it stops by itself at the last step.
  const autoplaying = playing && cursor < steps.length;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Autoplay owns a timer only while playing and clears it on pause or unmount.
  useEffect(() => {
    if (!autoplaying) return;
    const timer = setInterval(() => setCursor((value) => value + 1), PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoplaying]);

  const state = playSteps(steps, cursor);
  const keys = stepKeys(steps);
  const run = state.runs.at(-1);
  const turnOpen = run?.status === "running";

  const requests = playbackComposerRequests(state);

  // Hand-added steps replace whatever came after the cursor, so the timeline
  // and the step list never disagree.
  const insert = (next: ReadonlyArray<Step>) => {
    setSteps((current) => [...current.slice(0, cursor), ...next]);
    setCursor((value) => value + next.length);
    setPlaying(false);
  };
  // Answering a card is the user's step. When the script answers the same way
  // next, the card's answer takes that step's place and the script plays on;
  // a different outcome (denying what the script approved) ends the script there.
  const respond = (
    requestId: string,
    answer: Omit<Extract<Step, { kind: "resolve" }>, "kind" | "key">,
  ) => {
    const step: Step = { kind: "resolve", key: requestStepKey(requestId), ...answer };
    const scripted = steps[cursor];
    if (
      scripted?.kind === "resolve" &&
      scripted.key === step.key &&
      isDecline(scripted.decision) === isDecline(answer.decision)
    ) {
      setSteps((current) => current.map((entry, index) => (index === cursor ? step : entry)));
      setCursor((value) => value + 1);
      setPlaying(false);
      return;
    }
    insert([step]);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_17rem]">
      <section aria-label="Timeline" className="flex min-h-0 min-w-0 flex-col" data-scene-stage>
        <div className="min-h-0 flex-1">
          <PlaybackTimeline
            state={state}
            requests={requests}
            theme={resolvedTheme}
            onApprove={(requestId, decision) => respond(requestId, { decision })}
          />
        </div>
        <PlaybackComposer
          requests={requests}
          providerLabel={script.title.startsWith("Claude") ? "Claude" : "Codex"}
          onAnswer={(requestId, answers) => respond(requestId, { answers })}
          onBuildPlan={() => insert([{ kind: "turn", prompt: "Build the plan." }])}
        />
      </section>

      <aside
        aria-label="Turn controls"
        className="flex min-h-0 flex-col gap-4 border-s border-divider p-4"
      >
        <div className="flex flex-col gap-1">
          <Text variant="label" tone="strong">
            {script.title}
          </Text>
          <Text variant="caption" tone="muted">
            Contract items through the wire projection, rendered by the real timeline.
          </Text>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCursor(0)}
            disabled={cursor === 0}
          >
            Reset
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCursor((value) => Math.max(0, value - 1))}
            disabled={cursor === 0}
          >
            Back
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCursor((value) => Math.min(steps.length, value + 1))}
            disabled={cursor >= steps.length}
          >
            Step
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (autoplaying) {
                setPlaying(false);
                return;
              }
              if (cursor >= steps.length) setCursor(0);
              setPlaying(true);
            }}
          >
            {autoplaying ? "Pause" : "Play"}
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <Text variant="caption" tone="muted">
            Steps · {cursor}/{steps.length}
          </Text>
          <ol className="flex min-h-0 flex-col overflow-x-hidden overflow-y-auto">
            {steps.map((step, index) => (
              <li key={keys[index]}>
                <Button
                  variant={index < cursor ? "ghost" : "ghost-muted"}
                  size="xs"
                  aria-current={index === cursor - 1 ? "step" : undefined}
                  onClick={() => {
                    setPlaying(false);
                    setCursor(index + 1);
                  }}
                >
                  {index === cursor - 1 ? "▸ " : ""}
                  {stepLabel(step)}
                </Button>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex flex-col gap-2">
          <Text variant="caption" tone="muted">
            {turnOpen ? "Add to this turn" : "Start a turn to add tool calls"}
          </Text>
          <div className="flex flex-wrap gap-1">
            {addableSteps.map((entry) => (
              <Button
                key={entry.label}
                variant="secondary"
                size="xs"
                disabled={!turnOpen}
                onClick={() => {
                  insert(entry.steps(`added-${added}`));
                  setAdded((value) => value + 1);
                }}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {turnOpen ? (
              <>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => {
                    insert([
                      {
                        kind: "steer",
                        key: `steer-${added}`,
                        text: "Actually, keep it to one file for now.",
                      },
                    ]);
                    setAdded((value) => value + 1);
                  }}
                >
                  Steer
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => {
                    insert([
                      {
                        kind: "steer",
                        key: `steer-${added}`,
                        text: "Also update the tests when you are done.",
                        promoted: true,
                      },
                    ]);
                    setAdded((value) => value + 1);
                  }}
                >
                  Promote queued
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => insert([{ kind: "end", ending: "completed" }])}
                >
                  Complete turn
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => insert([{ kind: "end", ending: "interrupted", seconds: 5 }])}
                >
                  Stop
                </Button>
                <Button
                  variant="destructive-outline"
                  size="xs"
                  onClick={() => insert([{ kind: "end", ending: "failed" }])}
                >
                  Fail run
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => insert([{ kind: "turn", prompt: "Keep going." }])}
              >
                New turn
              </Button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Keys steps by turn, item and occurrence, which stays stable as steps are added after the cursor. */
function stepKeys(steps: ReadonlyArray<Step>): string[] {
  const seen = new Map<string, number>();
  let turn = 0;
  return steps.map((step) => {
    if (step.kind === "turn") turn += 1;
    const base =
      step.kind === "turn" || step.kind === "end"
        ? `${turn}:${step.kind}`
        : `${turn}:${step.kind}:${step.key}`;
    // An item streams several updates, so repeat steps are numbered.
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}:${count}`;
  });
}

function isDecline(decision: ProviderApprovalDecision | undefined) {
  return decision === "decline" || decision === "cancel";
}

function stepLabel(step: Step): string {
  switch (step.kind) {
    case "turn":
      return `Prompt: ${step.prompt}`;
    case "end":
      return step.ending === "completed"
        ? "Turn completes"
        : step.ending === "interrupted"
          ? "User stops"
          : "Run fails";
    case "start":
      return `Start ${step.key} (${step.body.type === "dynamic_tool" ? step.body.toolName : step.body.type.replaceAll("_", " ")})`;
    case "update":
      return `Stream ${step.key}`;
    case "finish":
      return `${step.status === "failed" ? "Fail" : "Finish"} ${step.key}`;
    case "request":
      return step.request.kind === "approval"
        ? `Ask approval (${step.request.requestKind})`
        : `Ask ${step.request.questions.length === 1 ? "a question" : `${step.request.questions.length} questions`}`;
    case "resolve":
      return isDecline(step.decision)
        ? `User declines ${step.key}`
        : step.answers
          ? `User answers ${step.key}`
          : `User approves ${step.key}`;
    case "plan":
      return "Propose a plan";
    case "steer":
      return `${step.promoted ? "Promote queued" : "Steer"}: ${step.text}`;
  }
}

import { useEffect, useRef, useState } from "react";
import type { LabUserInputQuestion, QuestionScenario } from "../data/fixtures";

/** Desktop waits this long after a single-choice pick, so the pick is seen before the step moves. */
export const AUTO_ADVANCE_MS = 200;

export interface Draft {
  readonly picked: ReadonlyArray<string>;
  readonly custom: string;
}

const EMPTY: Draft = { picked: [], custom: "" };

export function questions(scenario: QuestionScenario): ReadonlyArray<LabUserInputQuestion> {
  for (const entry of scenario.thread.entries) {
    if (entry.kind === "userInput") return entry.questions;
  }
  return [];
}

/** The agent's last text before it asked: the panel's context. */
export function contextMarkdown(scenario: QuestionScenario): string | undefined {
  let last: string | undefined;
  for (const entry of scenario.thread.entries) {
    if (entry.kind === "assistant") last = entry.text;
    if (entry.kind === "userInput") break;
  }
  return last;
}

export function isAnswered(draft: Draft | undefined) {
  return (draft?.picked.length ?? 0) > 0 || (draft?.custom.trim().length ?? 0) > 0;
}

/**
 * The pending question's state, shared by the panel and the prompt box (an answer typed there
 * stands in for the options): the step, every draft, the auto-advance after a single-choice pick.
 */
export function useQuestionFlow(scenario: QuestionScenario) {
  const list = questions(scenario);
  const [step, setStep] = useState(scenario.step);
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>(() => {
    const initial: Record<string, Draft> = {};
    for (const question of list) {
      initial[question.id] = {
        picked: scenario.picked[question.id] ?? [],
        custom: scenario.custom[question.id] ?? "",
      };
    }
    return initial;
  });
  const [advancing, setAdvancing] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a pending auto-advance on unmount
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const question = list[Math.min(step, list.length - 1)];
  const draftOf = (id: string) => drafts[id] ?? EMPTY;
  const setDraft = (id: string, draft: Draft) =>
    setDrafts((current) => ({ ...current, [id]: draft }));
  const canSubmit = list.every((item) => isAnswered(drafts[item.id]));

  const cancelAdvance = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setAdvancing(null);
  };
  const goTo = (next: number) => {
    cancelAdvance();
    setStep(next);
  };
  const select = (value: string) => {
    if (!question) return;
    const draft = draftOf(question.id);
    if (question.multiSelect) {
      const picked = draft.picked.includes(value)
        ? draft.picked.filter((item) => item !== value)
        : [...draft.picked, value];
      setDraft(question.id, { picked, custom: draft.custom });
      return;
    }
    setDraft(question.id, { picked: [value], custom: "" });
    if (step >= list.length - 1) return;
    cancelAdvance();
    setAdvancing(step);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setAdvancing(null);
      setStep(step + 1);
    }, AUTO_ADVANCE_MS);
  };
  const setCustom = (text: string) => {
    if (!question) return;
    setDraft(question.id, {
      picked: question.multiSelect ? draftOf(question.id).picked : [],
      custom: text,
    });
  };

  return {
    list,
    step: Math.min(step, list.length - 1),
    question,
    draft: question ? draftOf(question.id) : EMPTY,
    canSubmit,
    advancing,
    select,
    goTo,
    setCustom,
  };
}

export type QuestionFlow = ReturnType<typeof useQuestionFlow>;

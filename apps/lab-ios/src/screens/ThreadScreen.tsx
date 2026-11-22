import { useLayoutEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer";
import {
  AgentMessageCard,
  SubagentCard,
  UserBubble,
  WorkingDivider,
} from "../components/FeedCards";
import { GlassButton, GlassHeader } from "../components/GlassHeader";
import { MarkdownText } from "../components/Markdown";
import { QuestionPanel } from "../components/QuestionPanel";
import {
  FEED_THREAD,
  LAB_ENVIRONMENT_LABEL,
  QUESTION_SCENARIOS,
  type LabEntry,
  type LabThread,
} from "../data/fixtures";
import { contextMarkdown, useQuestionFlow } from "./useQuestionFlow";
import { PHONE_HEIGHT } from "../components/PhoneFrame";
import "./ThreadScreen.css";

const HEADER_HEIGHT = 116;
/** Feed the panel leaves in view above itself (apps/mobile QUESTION_PANEL_FEED_PEEK). */
const FEED_PEEK = 96;
const COMPOSER_SLOT = 84;
const PANEL_MAX = 560;

function FeedEntry(props: { readonly entry: LabEntry }) {
  const { entry } = props;
  switch (entry.kind) {
    case "user":
      return <UserBubble text={entry.text} time="4:48 PM" />;
    case "assistant":
      return (
        <div className="m-feed-text">
          <MarkdownText markdown={entry.text} />
        </div>
      );
    case "agentMessage":
      return <AgentMessageCard from={entry.from} text={entry.text} />;
    case "subagent":
      return (
        <SubagentCard
          provider={entry.instanceId}
          model={entry.model}
          title={entry.title}
          elapsed={entry.elapsed}
          state={
            entry.status === "running" ? "working" : entry.status === "failed" ? "failed" : "done"
          }
        />
      );
    case "delegatedNotice":
    case "userInput":
      return null;
  }
}

function Feed(props: { readonly thread: LabThread; readonly workingLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread opens at its newest message
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);
  const dividerIndex = props.thread.entries.findIndex(
    (entry) => entry.kind !== "user" && entry.kind !== "userInput",
  );
  return (
    <div className="m-feed m-scroll" ref={ref}>
      <div className="m-feed-inner">
        {props.thread.entries.map((entry, index) => {
          const showDivider = index === dividerIndex;
          return (
            // oxlint-disable-next-line react/no-array-index-key -- static fixture list
            <div className="m-feed-item" key={index}>
              {showDivider ? <WorkingDivider label={props.workingLabel} /> : null}
              <FeedEntry entry={entry} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuestionThread(props: { readonly scenario: string }) {
  const scenario = QUESTION_SCENARIOS[props.scenario] ?? QUESTION_SCENARIOS.single!;
  const flow = useQuestionFlow(scenario);
  const maxHeight = Math.min(
    PANEL_MAX,
    PHONE_HEIGHT - HEADER_HEIGHT - FEED_PEEK - COMPOSER_SLOT - 8,
  );
  return (
    <>
      <Feed thread={scenario.thread} workingLabel="Working for 18m 31s" />
      <div className="m-thread-bottom">
        <div className="m-thread-panel">
          <QuestionPanel flow={flow} context={contextMarkdown(scenario)} maxHeight={maxHeight} />
        </div>
        <Composer value={flow.draft.custom} onChange={flow.setCustom} />
      </div>
    </>
  );
}

function FeedThread() {
  const [draft, setDraft] = useState("");
  return (
    <>
      <Feed thread={FEED_THREAD} workingLabel="Working for 26m 54s" />
      <div className="m-thread-bottom">
        <Composer value={draft} onChange={setDraft} working />
      </div>
    </>
  );
}

/** The thread screen: glass header over the feed, the pending question above the prompt box. */
export function ThreadScreen(props: {
  readonly variant: "question" | "feed";
  readonly scenario?: string;
}) {
  const thread =
    props.variant === "question"
      ? (QUESTION_SCENARIOS[props.scenario ?? ""] ?? QUESTION_SCENARIOS.single!).thread
      : FEED_THREAD;
  return (
    <div className="m-thread">
      <GlassHeader
        title={thread.title}
        subtitle={`${thread.project} · ${LAB_ENVIRONMENT_LABEL}`}
        leading={<GlassButton icon="chevron-left" label="Back" />}
        trailing={<GlassButton icon="more-horizontal" label="More" />}
      />
      {props.variant === "question" ? (
        <QuestionThread key={props.scenario} scenario={props.scenario ?? "single"} />
      ) : (
        <FeedThread />
      )}
    </div>
  );
}

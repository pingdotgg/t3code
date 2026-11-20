import type { ReactNode } from "react";
import { Icon, ProviderIcon, type Provider } from "./Icon";
import { WithStatusDot, type DotState } from "./StatusDot";
import "./FeedCards.css";

/** The card face every inline thread card shares: --color-card-face, hairline border, lighter top edge. */
export function CardFace(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className={`m-card-face m-continuous ${props.className ?? ""}`}>{props.children}</div>
  );
}

export function UserBubble(props: { readonly text: string; readonly time: string }) {
  return (
    <div className="m-user">
      <div className="m-user-bubble m-continuous">{props.text}</div>
      <div className="m-user-meta">
        <span>{props.time}</span>
        <Icon name="copy" size={15} />
      </div>
    </div>
  );
}

/** "Working for 18m 31s" with a hairline under it. */
export function WorkingDivider(props: { readonly label: string }) {
  return (
    <div className="m-working">
      <div className="m-working-label">{props.label}</div>
      <div className="m-working-rule" />
    </div>
  );
}

/** A message another thread sent: the folded "Agent message" card. */
export function AgentMessageCard(props: { readonly from: string; readonly text: string }) {
  return (
    <CardFace>
      <div className="m-agentcard">
        <div className="m-agentcard-head">
          <span className="m-agentcard-from">{props.from}</span>
          <span className="m-agentcard-kind">Agent message</span>
          <Icon name="chevron-down" size={12} />
        </div>
        <div className="m-agentcard-text">{props.text}</div>
      </div>
    </CardFace>
  );
}

/** The inline child-task card: provider and model with the elapsed time, the title below. */
export function SubagentCard(props: {
  readonly provider: Provider;
  readonly model: string;
  readonly title: string;
  readonly elapsed: string;
  readonly state: DotState;
}) {
  return (
    <CardFace>
      <div className="m-subagent">
        <div className="m-subagent-head">
          <WithStatusDot state={props.state} ring="var(--color-card-face)">
            <ProviderIcon provider={props.provider} size={14} />
          </WithStatusDot>
          <span className="m-subagent-model">
            {props.provider === "claudeAgent" ? "Claude" : "Codex"} · {props.model}
          </span>
          <span className="m-subagent-elapsed m-tnum">{props.elapsed}</span>
        </div>
        <div className="m-subagent-title" data-working={props.state === "working"}>
          {props.title}
        </div>
      </div>
    </CardFace>
  );
}

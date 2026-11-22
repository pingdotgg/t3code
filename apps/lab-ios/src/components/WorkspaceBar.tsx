import type { IconName } from "../icons.generated";
import { Icon } from "./Icon";
import "./WorkspaceBar.css";

const TABS: ReadonlyArray<{ id: string; icon: IconName }> = [
  { id: "threads", icon: "thread" },
  { id: "tasks", icon: "checklist" },
  { id: "pull-requests", icon: "pull-request" },
  { id: "search", icon: "search" },
];

/** The floating bottom bar: a menu circle, the tab pill, a compose circle. */
export function WorkspaceBar(props: { readonly active: "threads" | "tasks" }) {
  return (
    <div className="m-wsbar">
      <button className="m-wsbar-circle" aria-label="More">
        <Icon name="more-horizontal" size={22} />
      </button>
      <div className="m-wsbar-tabs">
        {TABS.map((tab) => (
          <span key={tab.id} className="m-wsbar-tab" data-active={tab.id === props.active}>
            <Icon name={tab.icon} size={24} />
          </span>
        ))}
      </div>
      <button className="m-wsbar-circle" aria-label="New thread">
        <Icon name="add" size={24} />
      </button>
    </div>
  );
}

import { Icon, ProviderIcon } from "../components/Icon";
import { StatusDot } from "../components/StatusDot";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { LIST_THREADS, WORKING_THREADS, type ListThread } from "../data/fixtures";
import "./ThreadListScreen.css";

/** The project favicon: a monogram tile with the status dot on its top-right corner. */
function ProjectFavicon(props: { readonly project: string; readonly state: ListThread["state"] }) {
  return (
    <span className="m-favicon-host">
      <span className="m-favicon">{props.project.slice(0, 2).toUpperCase()}</span>
      <span className="m-favicon-dot">
        <StatusDot state={props.state} ring="var(--color-screen)" />
      </span>
    </span>
  );
}

/** Same layout as a Tasks row: favicon + title on line 1; project · branch · agent · time under the title. */
function ThreadRow(props: { readonly thread: ListThread; readonly recede?: boolean }) {
  const { thread } = props;
  return (
    <div className="m-row" data-recede={props.recede}>
      <div className="m-row-head">
        <ProjectFavicon project={thread.project} state={thread.state} />
        <span className="m-row-title">{thread.title}</span>
      </div>
      <div className="m-row-meta">
        <span className="m-row-agent">
          <ProviderIcon provider={thread.provider} size={13} muted={props.recede} />
        </span>
        {" · "}
        {thread.project}
        {thread.branch ? <> · {thread.branch}</> : null}
        {" · "}
        <span className="m-tnum">{thread.time}</span>
      </div>
    </div>
  );
}

function FilterPill(props: { readonly label: string }) {
  return (
    <button className="m-pill">
      {props.label}
      <Icon name="chevron-down" size={12} />
    </button>
  );
}

/** The thread list: filter pills on the 16pt edge, rows, a collapsible Working section. */
export function ThreadListScreen() {
  return (
    <div className="m-list">
      <div className="m-list-scroll m-scroll">
        <div className="m-pills">
          <FilterPill label="All environments" />
          <FilterPill label="All projects" />
        </div>
        {LIST_THREADS.map((thread) => (
          <ThreadRow key={thread.title} thread={thread} />
        ))}
        <div className="m-section">
          <span className="m-section-label">Working</span>
          <span className="m-section-rule" />
          <Icon name="chevron-up" size={12} />
        </div>
        {WORKING_THREADS.map((thread) => (
          <ThreadRow key={thread.title} thread={thread} recede />
        ))}
      </div>
      <WorkspaceBar active="threads" />
    </div>
  );
}

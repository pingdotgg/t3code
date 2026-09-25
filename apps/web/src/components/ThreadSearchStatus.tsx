import { Link } from "@tanstack/react-router";
import {
  threadSearchSourceMessage,
  THREAD_SEARCH_LIMIT,
  type ThreadSearchSource,
} from "@t3tools/client-runtime/state/thread-search";
import { Button } from "./ui/button";

export function ThreadSearchStatus(props: {
  readonly sources: ReadonlyArray<ThreadSearchSource>;
  readonly retry: () => void;
}) {
  if (props.sources.length === 0) return null;
  const messages = props.sources.flatMap((source) => {
    const message = threadSearchSourceMessage(source);
    return message === null ? [] : [{ environmentId: source.environmentId, message }];
  });
  return (
    <div className="px-2 py-2 text-xs text-muted-foreground">
      <p>
        Message search: unarchived threads, up to {THREAD_SEARCH_LIMIT} matches per environment.
      </p>
      <div role="status">
        {messages.map(({ environmentId, message }) => (
          <p key={environmentId}>{message}</p>
        ))}
      </div>
      {props.sources.some((source) => source.status === "failed") ? (
        <Button variant="ghost" size="xs" onClick={props.retry}>
          Retry message search
        </Button>
      ) : null}
      {props.sources.some(
        (source) => source.status === "disconnected" || source.status === "unsupported",
      ) ? (
        <Link to="/settings/connections" className="underline">
          Manage connections
        </Link>
      ) : null}
    </div>
  );
}

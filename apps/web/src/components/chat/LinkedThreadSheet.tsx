import { useAtom } from "@effect/atom-react";
import {
  isLinkedThreadWorking,
  linkedThreadFailure,
  type LinkedThreadItemPresentation,
  type LinkedThreadTarget,
  presentLinkedThreadItem,
} from "@t3tools/client-runtime/linked-thread";
import { T, useGT, useMessages, Var } from "gt-react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";

import { useEnvironment } from "../../state/environments";
import { linkedThreadViewAtom, useLinkedThreadSession } from "../../state/linkedThreadView";
import ChatMarkdown from "../ChatMarkdown";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";

function TruncatedNote() {
  return (
    <p className="mt-1 text-2xs text-muted-foreground">
      <T>Long text, cut short here.</T>
    </p>
  );
}

function LinkedThreadItem(props: { readonly item: LinkedThreadItemPresentation }) {
  const { item } = props;
  if (item.kind !== "activity") {
    return item.kind === "user" ? (
      <div className="ms-auto max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere">
        {item.text}
        {item.truncated ? <TruncatedNote /> : null}
      </div>
    ) : (
      <div className="min-w-0 text-sm">
        <ChatMarkdown text={item.text} cwd={undefined} />
        {item.truncated ? <TruncatedNote /> : null}
      </div>
    );
  }
  const summaryClassName = `min-w-0 truncate font-mono text-xs ${item.failed ? "text-destructive" : "text-muted-foreground"}`;
  if (item.body === null) {
    return <div className={`ps-4.5 ${summaryClassName}`}>{item.summary}</div>;
  }
  return (
    <details className="group/activity min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-open/activity:rotate-90"
        />
        <span className={summaryClassName}>{item.summary}</span>
      </summary>
      <pre className="mt-1 ms-4.5 max-h-80 overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-muted-foreground">
        {item.body}
      </pre>
      {item.truncated ? <TruncatedNote /> : null}
    </details>
  );
}

function LinkedThreadView(props: { readonly target: LinkedThreadTarget }) {
  const { target } = props;
  const gt = useGT();
  const m = useMessages();
  const via = useEnvironment(target.viaEnvironmentId)?.label ?? gt("this environment");
  const { state, session } = useLinkedThreadSession(target);
  const { transcript } = state;
  const label = transcript?.label ?? target.label;
  const failure = state.error === null ? null : linkedThreadFailure(state.error, { via, label }, m);
  const retry = failure?.retryable ? (
    <AlertAction>
      <Button size="sm" variant="outline" onClick={session.retry}>
        <T>Try again</T>
      </Button>
    </AlertAction>
  ) : null;
  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {transcript?.thread.title || target.title || gt("Thread on {label}", { label })}
        </SheetTitle>
        <SheetDescription>
          <span className="flex flex-wrap items-center gap-x-1.5">
            <EyeIcon aria-hidden className="size-3.5" />
            <T>
              Read-only · on <Var>{label}</Var> via <Var>{via}</Var>
            </T>
            {transcript !== null && isLinkedThreadWorking(transcript) ? (
              <span className="text-foreground/80">
                · <T>Working</T>
              </span>
            ) : null}
          </span>
        </SheetDescription>
        {/* A "Connect to interact" action belongs here once this client can pair with the linked environment. */}
      </SheetHeader>
      {/* Reversed, so the view opens at the newest item and stays there as items arrive. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto px-6 pb-6">
        <div className="flex flex-col gap-3">
          {transcript === null ? (
            failure === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size="sm" />
                <T>
                  Reading from <Var>{label}</Var>…
                </T>
              </div>
            ) : (
              <Alert variant="error">
                <AlertTitle>{failure.title}</AlertTitle>
                <AlertDescription>{failure.detail}</AlertDescription>
                {retry}
              </Alert>
            )
          ) : (
            <>
              {transcript.earlierPosition !== null ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={state.loadingEarlier}
                  onClick={() => void session.loadEarlier()}
                >
                  {state.loadingEarlier ? <Spinner /> : null}
                  <T>Load earlier</T>
                </Button>
              ) : null}
              {transcript.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <T>Nothing in this thread yet.</T>
                </p>
              ) : null}
              {transcript.items.map((item) => {
                const presented = presentLinkedThreadItem(item, m);
                return presented === null ? null : (
                  <LinkedThreadItem key={item.position} item={presented} />
                );
              })}
              {failure === null ? null : (
                <Alert variant="warning">
                  <AlertTitle>{failure.title}</AlertTitle>
                  <AlertDescription>
                    {failure.detail} <T>Showing what was read before.</T>
                  </AlertDescription>
                  {retry}
                </Alert>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * A linked environment's thread, read through the environment this client is connected to. The
 * client never connects to the linked one, so the view only reads.
 */
export function LinkedThreadSheet() {
  const [target, setTarget] = useAtom(linkedThreadViewAtom);
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      <SheetPopup side="right" className="w-[min(92vw,44rem)] max-w-none">
        {target === null ? null : (
          <LinkedThreadView
            key={`${target.viaEnvironmentId}:${target.environmentId}:${target.threadId}`}
            target={target}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

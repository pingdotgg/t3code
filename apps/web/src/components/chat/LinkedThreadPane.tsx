import {
  isLinkedThreadWorking,
  linkedThreadFailure,
  type LinkedThreadItemPresentation,
  presentLinkedThreadItem,
} from "@t3tools/client-runtime/linked-thread";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { type LinkedThreadSurface, linkedThreadTitle } from "../../linkedThreadSurface";
import { useEnvironment } from "../../state/environments";
import { useLinkedThreadSession } from "../../state/linkedThreadView";
import ChatMarkdown from "../ChatMarkdown";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerSurface } from "./ComposerSurface";
import {
  ReadOnlyComposerBar,
  ReadOnlyComposerLead,
  ReadOnlyComposerStatus,
} from "./ReadOnlyComposerBar";
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

/**
 * Stands where a composer would: the thread takes no messages from here. `action` is the one way
 * forward it offers, and `notice` what came of it.
 */
function LinkedThreadComposer(props: {
  /** The linked environment the thread is on. */
  readonly label: string;
  /** The environment that reads it. */
  readonly via: string;
  readonly working: boolean;
  readonly action?: ReactNode;
  readonly notice?: ComposerBannerStackItem | null;
}) {
  const { label, via } = props;
  const gt = useGT();
  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 pb-3">
      {props.notice ? <ComposerBannerStack items={[props.notice]} detached /> : null}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <div className="relative z-10">
            <ReadOnlyComposerBar actions={props.action}>
              <ReadOnlyComposerLead>
                <EyeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium text-foreground">
                  <T>Read-only</T>
                </span>
              </ReadOnlyComposerLead>
              <ReadOnlyComposerStatus role="status">
                {props.working
                  ? gt("On {label} via {via} · Working", { label, via })
                  : gt("On {label} via {via}", { label, via })}
              </ReadOnlyComposerStatus>
            </ReadOnlyComposerBar>
          </div>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/**
 * A linked environment's thread, read through the environment this client is connected to. The
 * client never connects to the linked one, so the view only reads. Key it by its surface id.
 */
export function LinkedThreadPane(props: {
  /** The thread whose panel shows the tab. */
  readonly panelRef: ScopedThreadRef;
  readonly surface: LinkedThreadSurface;
  /** Whether the tab is showing; reads wait while it is not. */
  readonly visible: boolean;
}) {
  const { surface, panelRef } = props;
  const gt = useGT();
  const m = useMessages();
  const via = useEnvironment(surface.viaEnvironmentId)?.label ?? gt("this environment");
  const { state, session } = useLinkedThreadSession(panelRef, surface, props.visible);
  const { transcript } = state;
  const label = transcript?.label ?? surface.label;
  const failure = state.error === null ? null : linkedThreadFailure(state.error, { via, label }, m);
  const retry = failure?.retryable ? (
    <AlertAction>
      <Button size="sm" variant="outline" onClick={session.retry}>
        <T>Try again</T>
      </Button>
    </AlertAction>
  ) : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h2 className="shrink-0 truncate border-b border-border px-3 py-2 text-sm font-medium">
        {linkedThreadTitle(
          { title: transcript?.thread.title || surface.title },
          gt("Thread on {label}", { label }),
        )}
      </h2>
      {/* Reversed, so the view opens at the newest item and stays there as items arrive. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto p-3">
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
      <LinkedThreadComposer
        label={label}
        via={via}
        working={transcript !== null && isLinkedThreadWorking(transcript)}
      />
    </div>
  );
}

import { isLinkedThreadWorking, linkedThreadFailure } from "@t3tools/client-runtime/linked-thread";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { EyeIcon, PlugIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { type LinkedThreadSurface, linkedThreadTitle } from "../../linkedThreadSurface";
import { useEnvironment } from "../../state/environments";
import {
  linkedThreadItemSource,
  useConnectLinkedEnvironment,
  useLinkedThreadView,
} from "../../state/linkedThreadView";
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
import { toastManager } from "../ui/toast";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import { ReadOnlyThreadTimeline } from "./ReadOnlyThreadTimeline";

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
    <div className="chat-composer-lane flex shrink-0 flex-col gap-1 pt-1.5 pb-4 sm:pt-2 sm:pb-5">
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

const NO_ATTACHMENT_URLS: ReadonlyMap<string, string> = new Map();
const noAttachmentUrls = () => NO_ATTACHMENT_URLS;
const ignore = () => {};

/**
 * A linked environment's thread, streamed through the environment this client is connected to
 * and drawn by the timeline every thread uses. The client never connects to the linked one, so
 * the view only reads: what would need that connection is absent. Key it by its surface id.
 */
export function LinkedThread(props: {
  /** The thread whose panel shows it as a tab, or null on the main screen. */
  readonly panelRef: ScopedThreadRef | null;
  readonly surface: LinkedThreadSurface;
  /** Whether it is showing; the stream runs only while it is. */
  readonly visible: boolean;
  /** What sits above the timeline on the main screen; a tab already names the thread. */
  readonly renderHeader?: (title: string) => ReactNode;
}) {
  const { surface, panelRef } = props;
  const gt = useGT();
  const m = useMessages();
  const via = useEnvironment(surface.viaEnvironmentId)?.label ?? gt("this environment");
  const { view, error, retry } = useLinkedThreadView(panelRef, surface, props.visible);
  const [turnItemSource] = useState(() => linkedThreadItemSource(surface));
  const label = surface.label;
  const projection = view?.thread.projection ?? null;
  const connection = useConnectLinkedEnvironment(panelRef, surface);
  const connectState = connection.state;
  const connecting = connectState.phase === "connecting";
  const connect = async () => {
    const outcome = await connection.connect();
    if (outcome.type === "connected") {
      toastManager.add({
        type: "success",
        title: gt("Connected to {label}", { label }),
        description: gt("This device is paired with it and can use its threads."),
      });
    }
  };
  const connectNotice: ComposerBannerStackItem | null =
    connectState.phase === "connecting"
      ? {
          id: "connecting",
          variant: "info",
          icon: <Spinner size="sm" />,
          title: gt("Connecting to {label}…", { label }),
        }
      : connectState.phase === "unreachable"
        ? {
            id: "unreachable",
            variant: "warning",
            icon: <PlugIcon />,
            title: gt("{label} is not reachable from this device", { label: connectState.label }),
            description: gt(
              "Join a network it is on, such as its Tailscale network, and try again. You can keep reading here.",
            ),
          }
        : connectState.phase === "manual"
          ? {
              id: "manual",
              variant: "info",
              icon: <PlugIcon />,
              title: gt("{label} needs a pairing code", { label: connectState.prefill.label }),
              description: gt("Create one on it, then add it to this device as an environment."),
              actions: (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => connection.addWithCode(connectState.prefill)}
                >
                  <T>Enter code</T>
                </Button>
              ),
            }
          : null;
  const connectAction = (
    <Button size="sm" variant="outline" disabled={connecting} onClick={() => void connect()}>
      <PlugIcon aria-hidden />
      <span className="@max-[320px]/composer-surface:sr-only">
        <T>Connect to interact</T>
      </span>
    </Button>
  );
  const failure = error === null ? null : linkedThreadFailure(error, { via, label }, m);
  const retryAction = failure?.retryable ? (
    <AlertAction>
      <Button size="sm" variant="outline" onClick={retry}>
        <T>Try again</T>
      </Button>
    </AlertAction>
  ) : null;
  // A file or visual lives on the linked environment, which this client has no way to ask.
  const renderHtmlRender = useStableCallback(() => (
    <p className="chat-content-lane text-xs text-muted-foreground">
      {gt("Open this thread on {label} to see this visual.", { label })}
    </p>
  ));
  const working = projection !== null && isLinkedThreadWorking(projection);
  const historyControls: MessagesTimelineHistoryControls | undefined =
    view === null || view.thread.historyCursor === null
      ? undefined
      : {
          hasMoreHistory: true,
          loading: view.history.loading,
          error: view.history.failed ? gt("Could not load earlier turns. Try again.") : null,
          onLoadEarlier: view.loadEarlier,
        };
  return (
    // `data-chat-canvas` gives the timeline the side gutters it has in a thread's own chat.
    <div
      data-chat-canvas
      className="flex h-full min-h-0 flex-col [--chat-lane-inset-end:0px] [--chat-lane-inset-start:0px] [--chat-timeline-gutter:0px]"
    >
      {props.renderHeader?.(
        linkedThreadTitle(
          { title: projection?.thread.title || surface.title },
          gt("Thread on {label}", { label }),
        ),
      )}
      {projection === null ? (
        <>
          <div className="chat-composer-lane min-h-0 flex-1 overflow-y-auto py-3">
            <div className="chat-content-lane">
              {failure === null ? (
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
                  {retryAction}
                </Alert>
              )}
            </div>
          </div>
          <LinkedThreadComposer
            label={label}
            via={via}
            working={false}
            notice={connectNotice}
            action={connectAction}
          />
        </>
      ) : (
        <ReadOnlyThreadTimeline
          // No ":" so the timeline finds no environment thread behind the key.
          threadKey={`linked-${encodeURIComponent(surface.id)}`}
          projection={projection}
          historyControls={historyControls}
          turnItemSource={turnItemSource}
          attachmentUrls={noAttachmentUrls}
          onImageExpand={ignore}
          onFileOpen={ignore}
          renderHtmlRender={renderHtmlRender}
          renderMcpApp={renderHtmlRender}
        >
          {() => (
            <>
              {failure === null ? null : (
                <div className="chat-composer-lane shrink-0 pb-2">
                  <div className="chat-content-lane">
                    <Alert variant="warning">
                      <AlertTitle>{failure.title}</AlertTitle>
                      <AlertDescription>
                        {failure.detail} <T>Showing what was read before.</T>
                      </AlertDescription>
                      {retryAction}
                    </Alert>
                  </div>
                </div>
              )}
              <LinkedThreadComposer
                label={label}
                via={via}
                working={working}
                notice={connectNotice}
                action={connectAction}
              />
            </>
          )}
        </ReadOnlyThreadTimeline>
      )}
    </div>
  );
}

/** A linked environment's thread as a right panel tab. Key it by its surface id. */
export function LinkedThreadPane(props: {
  /** The thread whose panel shows the tab. */
  readonly panelRef: ScopedThreadRef;
  readonly surface: LinkedThreadSurface;
  /** Whether the tab is showing. */
  readonly visible: boolean;
}) {
  return <LinkedThread panelRef={props.panelRef} surface={props.surface} visible={props.visible} />;
}

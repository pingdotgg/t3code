import { useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import type { PluginViewCloseReason } from "@t3tools/client-runtime/plugin-views/bridge";
import {
  buildPluginViewDocument,
  PLUGIN_VIEW_FRAME_ATTRIBUTES,
} from "@t3tools/client-runtime/plugin-views/document";
import { callPluginView } from "@t3tools/client-runtime/state/pluginViews";
import type { EnvironmentId, PluginView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { connectionAtomRuntime } from "~/connection/runtime";
import type { PluginViewSurface } from "~/rightPanelStore";
import { pluginViewEnvironment, usePluginViews } from "~/state/pluginViews";
import { useEnvironmentQuery } from "~/state/query";

import { usePanelHost } from "../panelHost";
import {
  awaitPluginViewReady,
  resolvePluginViewTarget,
  runPluginViewMount,
  sessionEpoch,
} from "./pluginViewHost";

/** The bootstrap posts `ready` as it parses, so a view silent this long never started. */
const READY_TIMEOUT_MS = 10_000;

type MountEnd = Exclude<PluginViewCloseReason, "closed"> | "not-started";

function PluginViewNotice(props: {
  title: string;
  description: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action ? (
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={props.action.onClick}>
            {props.action.label}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

const END_DESCRIPTIONS: Record<MountEnd, string> = {
  violations: "It sent too many messages T3 Code could not accept, so it was stopped.",
  unresponsive: "It stopped answering, so it was closed.",
  "not-started":
    "It did not start. It may have failed to load, or this page's security policy does not allow plugin views.",
};

/**
 * A plugin view from the thread's environment, mounted while the snapshot
 * from that environment's current session offers it. Disable, remove, a byte change, a
 * re-enable, or a new session tears the frame down at once; the tab stays so
 * the view can come back, and says why it is empty meanwhile.
 */
export default function PluginViewSidePanel(props: { readonly surface: PluginViewSurface }) {
  const { threadRef } = usePanelHost();
  const environmentId = threadRef.environmentId;
  const { session, views } = usePluginViews(environmentId);
  const target = resolvePluginViewTarget({
    views,
    surface: props.surface,
    session: sessionEpoch(session),
  });
  switch (target._tag) {
    case "waiting":
      return (
        <PluginViewNotice title={props.surface.title} description="Waiting for the environment." />
      );
    case "unsupported":
      return (
        <PluginViewNotice
          title="Plugin views are unavailable"
          description="This environment's T3 Code server cannot show plugin views."
        />
      );
    case "unavailable":
      return (
        <PluginViewNotice
          title={`${props.surface.title} is not available`}
          description={
            target.problem ??
            "Its plugin is disabled, removed, still loading, or changed since it was approved."
          }
        />
      );
    case "mount":
      return <PluginViewMount key={target.key} environmentId={environmentId} view={target.view} />;
  }
}

function PluginViewMount(props: { environmentId: EnvironmentId; view: PluginView }) {
  // The key fixes installation, generation and view, and a generation's manifest never changes.
  const [view] = useState(props.view);
  const { environmentId } = props;
  const bundle = useEnvironmentQuery(
    pluginViewEnvironment.bundle({
      environmentId,
      input: {
        installationId: view.installationId,
        generation: view.generation,
        viewId: view.viewId,
      },
    }),
  );
  const document = useMemo(
    () => (bundle.data === null ? null : buildPluginViewDocument(bundle.data, view.title)),
    [bundle.data, view.title],
  );
  const [ended, setEnded] = useState<MountEnd | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (bundle.error !== null && bundle.data === null)
    return (
      <PluginViewNotice
        title={`${view.title} could not load`}
        description={bundle.error}
        action={{ label: "Try again", onClick: bundle.refresh }}
      />
    );
  if (document === null)
    return <PluginViewNotice title={view.title} description="Loading the view." />;
  if (Result.isFailure(document))
    return (
      <PluginViewNotice
        title={`${view.title} could not load`}
        description={document.failure.message}
      />
    );
  if (ended !== null)
    return (
      <PluginViewNotice
        title={`${view.title} stopped`}
        description={END_DESCRIPTIONS[ended]}
        action={{
          label: "Reload",
          onClick: () => {
            setEnded(null);
            setAttempt((current) => current + 1);
          },
        }}
      />
    );
  return (
    <PluginViewFrame
      key={attempt}
      environmentId={environmentId}
      view={view}
      document={document.success}
      onEnd={setEnded}
    />
  );
}

function PluginViewFrame(props: {
  environmentId: EnvironmentId;
  view: PluginView;
  document: string;
  onEnd: (end: MountEnd) => void;
}) {
  const { environmentId, view, document } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const runtime = useAtomValue(connectionAtomRuntime);
  const services = AsyncResult.isSuccess(runtime) ? runtime.value : null;
  const onEndRef = useRef(props.onEnd);
  useLayoutEffect(() => {
    onEndRef.current = props.onEnd;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || services === null) return;
    let live = true;
    const end = (reason: MountEnd) => {
      if (!live) return;
      live = false;
      onEndRef.current(reason);
    };
    // The host fixes the target; nothing the view sends can name another one.
    const call = (handler: string, input: Schema.Json) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          registry.run(
            environmentId,
            callPluginView({
              installationId: view.installationId,
              generation: view.generation,
              viewId: view.viewId,
              handler,
              input,
            }),
          ),
        ),
        Effect.map((result) => result.value),
      );

    // oxlint-disable-next-line react/iframe-missing-sandbox -- The sandbox is set on the next line.
    const frame = window.document.createElement("iframe");
    frame.setAttribute("sandbox", PLUGIN_VIEW_FRAME_ATTRIBUTES.sandbox);
    frame.setAttribute("referrerpolicy", PLUGIN_VIEW_FRAME_ATTRIBUTES.referrerpolicy);
    frame.setAttribute("allow", PLUGIN_VIEW_FRAME_ATTRIBUTES.allow);
    frame.title = view.title;
    frame.className = "block size-full border-0";

    let mount: Fiber.Fiber<never, unknown> | null = null;
    const stopWaiting = awaitPluginViewReady({
      host: window,
      viewWindow: () => frame.contentWindow?.[0] ?? null,
      onConnect: (port) => {
        window.clearTimeout(readyTimeout);
        mount = Effect.runForkWith(services)(
          Effect.scoped(
            runPluginViewMount({
              port,
              view,
              call,
              onClose: (reason) => {
                if (reason !== "closed") end(reason);
              },
            }),
          ),
        );
      },
    });
    const readyTimeout = window.setTimeout(() => {
      stopWaiting();
      end("not-started");
    }, READY_TIMEOUT_MS);
    // The DOM property, unescaped: the builder already produced the exact wrapper document.
    frame.srcdoc = document;
    container.append(frame);

    return () => {
      live = false;
      window.clearTimeout(readyTimeout);
      stopWaiting();
      if (mount !== null) Effect.runFork(Fiber.interrupt(mount));
      frame.remove();
    };
  }, [environmentId, view, document, services]);

  return <div ref={containerRef} className="min-h-0 flex-1" />;
}

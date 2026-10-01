import { describeGrantDenial } from "@t3tools/extension-sdk/capabilities";
import type { Json, ViewContext, ViewRecord } from "@t3tools/extension-sdk/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import {
  presentationStateKey,
  restorePresentationState,
  savePresentationState,
} from "./presentationState";
import { installedSurfaceDescriptor, WorkspaceExtensionSurface } from "./workspaceRegistry";
import {
  installedApiSelectionRevision,
  resolveInstalledApiProvider,
  subscribeInstalledApiClients,
} from "./installedApiClients";

export interface PresentationRequest {
  readonly apiId: string;
  readonly method: string;
  readonly input: Json;
  /**
   * Host-local explicit navigation identity; never forwarded as API input. A
   * new one reopens through the provider and reaches the mounted view in
   * place when the provider answers with the same surface.
   */
  readonly navigationId?: string;
  /**
   * Sent instead of `input` when the selected provider is at `version` or a
   * later minor (a minor-release addition such as a file link's line).
   */
  readonly newerInput?: { readonly version: string; readonly input: Json };
}

/**
 * A file link's `t3.file/presentation.open`: the path, and its line for a
 * provider that takes one (1.1.0).
 */
export function filePresentationRequest(
  relativePath: string,
  line: number | null,
  navigationId?: string,
): PresentationRequest {
  return {
    apiId: "t3.file/presentation",
    method: "open",
    ...(navigationId === undefined ? {} : { navigationId }),
    input: { relativePath },
    ...(line !== null ? { newerInput: { version: "1.1.0", input: { relativePath, line } } } : {}),
  };
}

/**
 * Asks the selected provider to present `request` and returns the view it
 * names, or null when no provider is selected and the native panel presents.
 * Rejects when the provider cannot present it.
 */
async function presentSelected(
  request: PresentationRequest,
  context: ViewContext,
  signal: AbortSignal,
): Promise<ViewRecord | null> {
  const selected = await resolveInstalledApiProvider(request.apiId, context, signal);
  if (!selected) return null;
  const newer = request.newerInput;
  const upgrade =
    newer !== undefined && satisfiesSemverRange(selected.discovery.version, "^" + newer.version);
  const value = await selected.client.invokeApi(
    {
      id: request.apiId,
      versionRange: upgrade ? "^" + newer.version : "^1.0.0",
      method: request.method,
      input: upgrade ? newer.input : request.input,
      context,
      expectedGeneration: selected.discovery.generation,
    },
    signal,
  );
  signal.throwIfAborted();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("surfaceId" in value) ||
    typeof value.surfaceId !== "string" ||
    !value.surfaceId.startsWith(selected.discovery.pluginId + "/") ||
    !("placement" in value) ||
    value.placement !== "side-panel" ||
    !("restoreState" in value) ||
    !value.restoreState ||
    typeof value.restoreState !== "object" ||
    Array.isArray(value.restoreState)
  )
    throw new Error("Selected API provider returned an incompatible presentation");
  const descriptor = installedSurfaceDescriptor(
    context.resource.environmentId,
    selected.discovery.pluginId!,
    value.surfaceId,
  );
  if (!descriptor || !descriptor.placements.includes(value.placement))
    throw new Error("Selected API provider surface or placement is unavailable");
  return {
    version: 1,
    surfaceId: value.surfaceId,
    placement: "side-panel",
    stateVersion: descriptor.stateVersion,
    restoreState: value.restoreState,
    context,
    fallback: "Selected presentation unavailable",
  };
}

/** The view identity: its API, context and selected provider; a new request only navigates it. */
function presentationViewKey(
  apiId: string,
  method: string,
  context: ViewContext,
  revision: string,
) {
  return JSON.stringify([apiId, method, context, revision]);
}

/**
 * The last explicit navigation the host presented before opening its view,
 * for that view to take rather than ask the provider again. It names its
 * navigation, context and provider revision, so any other view asks.
 */
let presented: { readonly key: string; readonly record: ViewRecord | null } | undefined;

/**
 * `presentSelected` for a view the host is about to open with this request,
 * which must carry its `navigationId`. Rejects, leaving no view, when the
 * provider cannot present it.
 */
export async function presentBeforeOpen(
  request: PresentationRequest,
  context: ViewContext,
  signal: AbortSignal,
): Promise<void> {
  const key = JSON.stringify([
    presentationViewKey(
      request.apiId,
      request.method,
      context,
      installedApiSelectionRevision(context.resource.environmentId, request.apiId),
    ),
    request.navigationId,
  ]);
  const record = await presentSelected(request, context, signal);
  presented = { key, record };
}

/** Domain adapters supply requests; this component knows no panel kinds or plugin ids. */
export function SelectedApiPresentation(props: {
  request: PresentationRequest;
  context: ViewContext;
  visible: boolean;
  fallback: ReactNode;
}) {
  const getRevision = useCallback(
    () => installedApiSelectionRevision(props.context.resource.environmentId, props.request.apiId),
    [props.context.resource.environmentId, props.request.apiId],
  );
  const revision = useSyncExternalStore(subscribeInstalledApiClients, getRevision, getRevision);
  // The view lives as long as its API, context and provider; a new request
  // only navigates it.
  const key = presentationViewKey(
    props.request.apiId,
    props.request.method,
    props.context,
    revision,
  );
  const requestKey = JSON.stringify(props.request);
  const [state, setState] = useState<{
    key: string;
    record?: ViewRecord;
    storageKey?: string;
    navigation?: { readonly id: string; readonly restoreState: Json };
    /** A later open that failed; the view it could not navigate stays. */
    navigationError?: string;
    error?: string;
    legacy?: boolean;
  }>();
  // The mounted surface keeps the record handler it was created with, so the
  // handler reads the current state rather than that render's.
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  });
  useEffect(() => {
    const controller = new AbortController();
    const request = JSON.parse(requestKey) as PresentationRequest;
    const context = JSON.parse(key)[2] as ViewContext;
    void (async () => {
      try {
        const handed =
          presented?.key === JSON.stringify([key, request.navigationId]) ? presented : undefined;
        const record = handed
          ? handed.record
          : await presentSelected(request, context, controller.signal);
        controller.signal.throwIfAborted();
        if (!record) {
          setState({ key, legacy: true });
          return;
        }
        const storageKey = presentationStateKey(JSON.stringify([request, context]), record);
        // The same surface is navigated in place, keeping its session, edits
        // and saved state, which moves to the new request's key; only a first
        // or different view restores saved state.
        const previous = latest.current;
        const kept =
          previous?.key === key && previous.record?.surfaceId === record.surfaceId
            ? previous.record
            : undefined;
        if (kept) savePresentationState(storageKey, kept);
        setState({
          key,
          storageKey,
          navigation: { id: requestKey, restoreState: record.restoreState },
          record: kept ?? restorePresentationState(storageKey, record),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message =
          describeGrantDenial(error)?.message ??
          (error instanceof Error ? error.message : "Selected presentation unavailable");
        // A failed navigation keeps the mounted view and its edits, and says
        // the open failed.
        setState((previous) =>
          previous?.key === key && previous.record
            ? { ...previous, navigationError: message }
            : { key, error: message },
        );
      }
    })();
    return () => controller.abort();
  }, [key, requestKey]);
  if (state?.key !== key) return <div role="status">Resolving presentation…</div>;
  if (state.error) return <div role="status">{state.error}</div>;
  if (state.legacy) return props.fallback;
  return state.record ? (
    <>
      {state.navigationError ? (
        <div role="alert" className="border-b px-3 py-2 text-destructive text-xs">
          {state.navigationError}
        </div>
      ) : null}
      <WorkspaceExtensionSurface
        record={state.record}
        visible={props.visible}
        {...(state.navigation ? { navigation: state.navigation } : {})}
        onRecordChange={(record) => {
          const current = latest.current;
          if (current?.key !== key || current.storageKey === undefined) return;
          try {
            savePresentationState(current.storageKey, record);
          } catch {
            setState({ key, error: "Could not save presentation state" });
            return;
          }
          setState({ ...current, record });
        }}
      />
    </>
  ) : null;
}

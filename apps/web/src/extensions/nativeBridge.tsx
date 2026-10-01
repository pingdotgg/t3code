import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Json, ViewRecord } from "@t3tools/extension-sdk/contracts";
import {
  createExtensionHost,
  type Extension,
  type ExtensionHost,
  type HostOptions,
} from "@t3tools/extension-sdk/host";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { extensionTabKey, setExtensionTabIndicators } from "./extensionTabIndicators";

interface MountedView {
  readonly host: ExtensionHost<SurfaceRenderer>;
  readonly viewId: string;
  readonly recordKey: string;
}

/** Trusted bundled bindings stay in React; only the resource record enters the SDK. */
export function createNativeSurfaceBridge<Bindings>(
  createExtension: (useBindings: () => Bindings) => Extension<SurfaceRenderer>,
  hostOptions: HostOptions = { authorize: () => false },
) {
  // Copy registration configuration; grants may be revoked through the fixed callback.
  const options: HostOptions = {
    ...hostOptions,
    ...(hostOptions.services
      ? { services: hostOptions.services.map((service) => ({ ...service })) }
      : {}),
  };
  const BindingsContext = createContext<{ value: Bindings } | null>(null);
  const extension = createExtension(() => {
    const bindings = useContext(BindingsContext);
    if (!bindings) throw new Error("Native surface bindings are unavailable");
    return bindings.value;
  });

  function NativeSurface(props: {
    readonly bindings: Bindings;
    readonly record: ViewRecord;
    readonly visible: boolean;
    readonly retainHiddenPresentation?: boolean;
    readonly onRecordChange?: (record: ViewRecord) => void;
    /**
     * An open aimed at the live view. A new `id` reaches the mounted view in
     * place (`ExtensionHost.navigate`); the one it mounted with is skipped.
     */
    readonly navigation?: { readonly id: string; readonly restoreState: Json };
  }) {
    const { bindings, visible, navigation } = props;
    const recordKey = JSON.stringify({ ...props.record, restoreState: null });
    const currentRecord = useRef(props.record);
    const onRecordChange = useRef(props.onRecordChange);
    const visibility = useRef(visible);
    useLayoutEffect(() => {
      currentRecord.current = props.record;
      onRecordChange.current = props.onRecordChange;
      visibility.current = visible;
    }, [props.record, props.onRecordChange, visible]);
    const bindingValue = useMemo(() => ({ value: bindings }), [bindings]);
    // A surface that declared terminal focus gets the host-owned arbitration tag
    // on its frame; capture-phase keybinding dispatch then leaves the surface's
    // keys alone instead of acting on a native terminal.
    const claimsTerminalFocus = extension.manifest.surfaces.some(
      (surface) => surface.id === props.record.surfaceId && surface.claimsTerminalFocus === true,
    );
    const [mounted, setMounted] = useState<MountedView | null>(null);
    const activeHost = useRef<ExtensionHost<SurfaceRenderer> | null>(null);
    const activeView = useRef<MountedView | null>(null);
    const [failure, setFailure] = useState<{ recordKey: string; text: string } | null>(null);
    useEffect(() => {
      const host = createExtensionHost<SurfaceRenderer>(options);
      activeHost.current = host;
      const persistRecord = onRecordChange.current;
      let closed = false;
      host.register(extension);
      let saved = JSON.stringify(currentRecord.current.restoreState);
      const tabKey = extensionTabKey(currentRecord.current);
      const unsubscribe = host.subscribe((next) => {
        if (!next || closed) return;
        // The tab strip renders these; the view never touches host chrome.
        setExtensionTabIndicators(tabKey, next.tab ?? null);
        // Loading is published before the factory starts, so visibility also governs activation.
        activeView.current = { host, viewId: next.id, recordKey };
        if (!visibility.current && next.status !== "hidden") host.hide(next.id);
        const nextSaved = JSON.stringify(next.record.restoreState);
        if (saved === nextSaved) return;
        saved = nextSaved;
        persistRecord?.(next.record);
      });
      // Layout records reference resources already created by an explicit host command.
      void host.restore(currentRecord.current).then(
        (viewId) => {
          if (closed) return;
          if (!visibility.current) host.hide(viewId);
          setMounted({ host, viewId, recordKey });
        },
        (error: unknown) => {
          if (!closed)
            setFailure({
              recordKey,
              text: error instanceof Error ? error.message : "Surface unavailable",
            });
        },
      );
      return () => {
        if (activeHost.current === host) activeHost.current = null;
        if (activeView.current?.host === host) activeView.current = null;
        const record = host.records()[0];
        if (record && JSON.stringify(record.restoreState) !== saved) persistRecord?.(record);
        closed = true;
        unsubscribe();
        host.dispose();
        setExtensionTabIndicators(tabKey, null);
      };
    }, [recordKey]);
    useEffect(() => {
      // Activity reconnects effects while retaining mounted state from the disposed host.
      const view = activeView.current;
      if (!view || view.recordKey !== recordKey || activeHost.current !== view.host) return;
      if (visible) void view.host.show(view.viewId);
      else view.host.hide(view.viewId);
    }, [recordKey, visible]);
    // A record mounts with its own restore state; later navigations go in place.
    const navigated = useRef({ recordKey, id: navigation?.id });
    useEffect(() => {
      if (navigated.current.recordKey !== recordKey) {
        navigated.current = { recordKey, id: navigation?.id };
        return;
      }
      if (!navigation || navigated.current.id === navigation.id) return;
      if (mounted?.recordKey !== recordKey || activeHost.current !== mounted.host) return;
      navigated.current = { recordKey, id: navigation.id };
      mounted.host.navigate(mounted.viewId, navigation.restoreState).catch(() => {});
    }, [mounted, recordKey, navigation]);
    const rendered =
      mounted?.recordKey === recordKey ? (
        <ExtensionSurface
          host={mounted.host}
          viewId={mounted.viewId}
          retainHiddenPresentation={props.retainHiddenPresentation ?? false}
          className={
            props.record.placement === "bottom-dock"
              ? "contents"
              : "flex h-full min-h-0 min-w-0 flex-col"
          }
        />
      ) : failure?.recordKey === recordKey ? (
        <div role="status">{failure.text}</div>
      ) : null;
    return (
      <BindingsContext value={bindingValue}>
        {claimsTerminalFocus ? (
          // display: contents keeps the existing layout wrapper the only box;
          // the tag just marks this subtree as extension-owned terminal focus.
          <div
            data-terminal-owner="extension"
            data-terminal-placement={props.record.placement}
            className="contents"
          >
            {rendered}
          </div>
        ) : (
          rendered
        )}
      </BindingsContext>
    );
  }
  return { extension, Surface: NativeSurface };
}

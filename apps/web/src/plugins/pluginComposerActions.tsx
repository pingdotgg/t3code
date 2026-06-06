import type { PluginCatalogEntry, PluginComposerActionContribution } from "@t3tools/contracts";
import type {
  ComposerPluginActionState,
  PluginComposerApi,
  PluginUiFactory,
} from "@t3tools/plugin-api/ui";
import { useNavigate, type AnyRouter } from "@tanstack/react-router";
import * as React from "react";
import { useEffect, useMemo } from "react";

import type { WsRpcClient } from "@t3tools/client-runtime";

import { hasPluginManifest, type PluginCatalogManifestEntry } from "./pluginCatalogEntry";
import { resolvePluginContributionReadiness } from "./pluginNavigation";
import { usePluginHostState } from "./pluginHostStore";
import {
  createPluginComposerActionContext,
  createPluginContextBase,
  PluginUiErrorBoundary,
  type DynamicPluginNavigate,
  usePluginUiRegistration,
} from "./pluginUiRuntime";

export type PluginComposerActionStateUpdate = ComposerPluginActionState | null;

export interface PluginComposerActionStateChange {
  readonly actionKey: string;
  readonly composerId: string;
  readonly state: PluginComposerActionStateUpdate;
}

type PluginComposerAction = PluginComposerActionContribution;
type PluginComposerActionPosition = PluginComposerAction["position"];

function compareComposerActions(
  left: {
    readonly catalogEntry: PluginCatalogManifestEntry;
    readonly action: PluginComposerAction;
  },
  right: {
    readonly catalogEntry: PluginCatalogManifestEntry;
    readonly action: PluginComposerAction;
  },
): number {
  const orderCompare = (left.action.order ?? 0) - (right.action.order ?? 0);
  if (orderCompare !== 0) return orderCompare;

  const labelCompare = left.action.label.localeCompare(right.action.label);
  if (labelCompare !== 0) return labelCompare;

  return `${left.catalogEntry.manifest.id}:${left.action.id}`.localeCompare(
    `${right.catalogEntry.manifest.id}:${right.action.id}`,
  );
}

function getActiveComposerActionEntries(
  catalog: ReadonlyArray<PluginCatalogEntry>,
  position: PluginComposerActionPosition,
) {
  return catalog
    .flatMap((catalogEntry) => {
      if (!hasPluginManifest(catalogEntry) || catalogEntry.status.status !== "active") return [];
      return (catalogEntry.manifest.ui.composerActions ?? [])
        .filter((action) => action.position === position)
        .map((action) => ({ catalogEntry, action }));
    })
    .toSorted(compareComposerActions);
}

function PluginComposerActionRenderer({
  catalogEntry,
  action,
  factoryKey,
  factory,
  client,
  navigate,
  composer,
  onActionStateChange,
}: {
  readonly catalogEntry: PluginCatalogManifestEntry;
  readonly action: PluginComposerAction;
  readonly factoryKey: string;
  readonly factory: PluginUiFactory;
  readonly client: WsRpcClient;
  readonly navigate: DynamicPluginNavigate;
  readonly composer: Omit<PluginComposerApi, "setActionState">;
  readonly onActionStateChange: (event: PluginComposerActionStateChange) => void;
}) {
  const actionKey = [factoryKey, action.id].join("\u0000");
  const composerId = composer.composerId;
  const activeRef = React.useRef(true);
  const setActionState = React.useCallback(
    (nextState: ComposerPluginActionState) => {
      if (activeRef.current) {
        onActionStateChange({ actionKey, composerId, state: nextState });
      }
    },
    [actionKey, composerId, onActionStateChange],
  );

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      onActionStateChange({ actionKey, composerId, state: null });
    };
  }, [actionKey, composerId, onActionStateChange]);

  const baseContext = useMemo(
    () =>
      createPluginContextBase({
        cacheKey: factoryKey,
        client,
        catalogEntry,
        navigate,
      }),
    [client, catalogEntry, factoryKey, navigate],
  );
  const context = useMemo(
    () =>
      createPluginComposerActionContext({
        baseContext,
        action,
        composer,
        setActionState,
      }),
    [action, baseContext, composer, setActionState],
  );
  const registrationState = usePluginUiRegistration({
    cacheKey: factoryKey,
    factory,
  });
  if (registrationState.status !== "ready") return null;
  const registration = registrationState.registration;
  const ActionComponent = registration.composerActions?.[action.id];
  if (!ActionComponent) return null;

  return (
    <PluginUiErrorBoundary
      resetKey={actionKey}
      renderError={() => null}
      onError={() => onActionStateChange({ actionKey, composerId, state: null })}
    >
      {React.createElement(ActionComponent, { ctx: context })}
    </PluginUiErrorBoundary>
  );
}

export function PluginComposerActions({
  position,
  composer,
  onActionStateChange,
}: {
  readonly position: PluginComposerActionPosition;
  readonly composer: Omit<PluginComposerApi, "setActionState">;
  readonly onActionStateChange: (event: PluginComposerActionStateChange) => void;
}) {
  const hostState = usePluginHostState();
  const navigate = useNavigate<AnyRouter>();
  const entries = useMemo(
    () => getActiveComposerActionEntries(hostState.catalog, position),
    [hostState.catalog, position],
  );

  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((entry) => {
        const readiness = resolvePluginContributionReadiness({
          hostState,
          pluginId: entry.catalogEntry.manifest.id,
          resolveContribution: (catalogEntry) => {
            const action = (catalogEntry.manifest.ui.composerActions ?? []).find(
              (candidate) => candidate.id === entry.action.id && candidate.position === position,
            );
            return action
              ? { status: "ready", contribution: action }
              : {
                  status: "missing",
                  message: `Plugin composer action ${entry.action.id} was not found.`,
                };
          },
        });
        if (readiness.status !== "ready") return null;
        const key = [readiness.factoryKey, readiness.contribution.id].join("\u0000");
        return (
          <PluginComposerActionRenderer
            key={key}
            catalogEntry={readiness.catalogEntry}
            action={readiness.contribution}
            factoryKey={readiness.factoryKey}
            factory={readiness.factory}
            client={readiness.client}
            navigate={navigate}
            composer={composer}
            onActionStateChange={onActionStateChange}
          />
        );
      })}
    </>
  );
}

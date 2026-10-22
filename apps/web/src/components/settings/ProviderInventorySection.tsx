import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderDisabledInventory,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInventoryItem,
  type ProviderInventoryKind,
  type ProviderInventorySection as InventorySection,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { cn } from "~/lib/utils";
import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { countDisabledInventory, inventoryItemDetail } from "./ProviderInventorySection.logic";

const GROUPS: ReadonlyArray<{ readonly kind: ProviderInventoryKind; readonly title: string }> = [
  { kind: "connectors", title: "Connectors" },
  { kind: "plugins", title: "Plugins" },
  { kind: "mcpServers", title: "MCP servers" },
  { kind: "skills", title: "Skills" },
];
const COLLAPSED_ROWS = 8;

function manageHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

/**
 * Starts the provider to list what it loads from the user's account and
 * configuration. Mount it only when the user asks to see the list.
 */
export function ProviderInventoryList(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly disabled: ProviderDisabledInventory | undefined;
  readonly readOnly?: boolean;
}) {
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(
    props.environmentId,
  );
  const query = useEnvironmentQuery(
    serverEnvironment.providerInventory({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    }),
  );
  const inventory = query.data;

  if (inventory === null) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground sm:px-4">
        {query.error ? (
          <>
            <span className="min-w-0 flex-1 text-destructive">{query.error}</span>
            <Button size="xs" variant="ghost" onClick={query.refresh}>
              Retry
            </Button>
          </>
        ) : (
          <>
            <Spinner size="xs" tone="muted" />
            Starting the provider to see what it loads…
          </>
        )}
      </div>
    );
  }

  const host = manageHost(inventory.manageUrl);
  const listedGroups = GROUPS.filter(({ kind }) => inventory[kind]._tag !== "Unsupported");
  const toggleItem = async (kind: ProviderInventoryKind, itemId: string, enabledInT3: boolean) => {
    if (props.readOnly || !canManage) return;
    const result = await persistProviderInstance({
      operation: "set-inventory-item",
      instanceId: props.instanceId,
      driver: props.driver,
      kind,
      itemId,
      enabledInT3,
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save provider settings",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  };

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          {listedGroups.length === 0
            ? "T3 can't list connectors for this provider yet."
            : "Switching something off only changes T3. Changes apply when the provider is idle; running work keeps its current tools."}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {host && inventory.manageUrl ? (
            <Button
              size="xs"
              variant="ghost"
              render={<a href={inventory.manageUrl} target="_blank" rel="noreferrer" />}
            >
              Manage on {host}
              <ExternalLinkIcon />
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" disabled={query.isPending} onClick={query.refresh}>
            {query.isPending ? <Spinner size="xs" /> : null}
            Refresh
          </Button>
        </div>
      </div>
      {query.error ? <p className="mt-2 text-xs text-destructive">{query.error}</p> : null}
      {listedGroups.map(({ kind, title }) => (
        <InventoryGroup
          key={kind}
          title={title}
          section={inventory[kind]}
          disabledIds={props.disabled?.[kind]}
          onToggle={
            !props.readOnly && canManage
              ? (id, enabledInT3) => {
                  void toggleItem(kind, id, enabledInT3);
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}

function InventoryGroup(props: {
  readonly title: string;
  readonly section: InventorySection;
  readonly disabledIds: ReadonlyArray<string> | undefined;
  readonly onToggle: ((id: string, enabledInT3: boolean) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const { section } = props;
  if (section._tag === "Unsupported") return null;
  if (section._tag === "Failed") {
    return (
      <div>
        <GroupLabel title={props.title} />
        <p className="px-2 text-xs text-destructive">{section.message}</p>
      </div>
    );
  }
  // A plugin's own entries sort after the user's, since most come and go with the plugin.
  const items = [
    ...section.items.filter((item) => !item.plugin),
    ...section.items.filter((item) => item.plugin),
  ];
  const visible = expanded ? items : items.slice(0, COLLAPSED_ROWS);
  const disabledIds = new Set(props.disabledIds);
  const onToggle = section.canDisable ? props.onToggle : undefined;
  return (
    <div>
      <GroupLabel title={props.title} count={items.length} />
      {items.length === 0 ? <p className="px-2 text-xs text-muted-foreground">None</p> : null}
      {visible.map((item) => (
        <InventoryRow
          key={item.id}
          item={item}
          enabledInT3={!disabledIds.has(item.id)}
          onToggle={onToggle ? (enabledInT3) => onToggle(item.id, enabledInT3) : undefined}
        />
      ))}
      {items.length > visible.length ? (
        <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(true)}>
          Show {items.length - visible.length} more
        </Button>
      ) : null}
    </div>
  );
}

function GroupLabel(props: { readonly title: string; readonly count?: number }) {
  return (
    <div className="px-2 pt-4 pb-1.5 text-2xs text-muted-foreground">
      {props.title}
      {props.count === undefined ? null : ` · ${props.count}`}
    </div>
  );
}

function InventoryRow(props: {
  readonly item: ProviderInventoryItem;
  readonly enabledInT3: boolean;
  readonly onToggle: ((enabledInT3: boolean) => void) | undefined;
}) {
  const { item } = props;
  const detail = inventoryItemDetail(item);
  return (
    <div
      className={cn(
        "flex min-h-7 items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/30",
        !props.enabledInT3 && "opacity-50",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm">{item.name}</span>
          {detail ? <ItemDetail item={item} detail={detail} /> : null}
        </div>
        {item.description ? (
          <p className="line-clamp-2 text-2xs text-muted-foreground">{item.description}</p>
        ) : null}
      </div>
      {props.onToggle ? (
        <Switch
          size="sm"
          checked={props.enabledInT3}
          onCheckedChange={props.onToggle}
          aria-label={`Use ${item.name} in T3`}
        />
      ) : null}
    </div>
  );
}

function ItemDetail(props: { readonly item: ProviderInventoryItem; readonly detail: string }) {
  const { item } = props;
  const label = (
    <span
      className={cn(
        "shrink-0 text-2xs",
        item.status === "failed"
          ? "text-destructive"
          : item.status === "needsAuth"
            ? "text-warning"
            : "text-muted-foreground/70",
      )}
    >
      {props.detail}
    </span>
  );
  if (!item.error) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipPopup side="top" className="max-w-80">
        {item.error}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ProviderInventorySection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly disabled: ProviderDisabledInventory | undefined;
  readonly readOnly?: boolean;
}) {
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  if (!canManage) return null;
  const offCount = countDisabledInventory(props.disabled);
  return (
    <FoldedSettingsSection
      id={`provider-instance-${props.instanceId}-inventory`}
      title="Connectors, plugins & skills"
      summary={offCount > 0 ? `${offCount} off in T3` : null}
    >
      <ProviderInventoryList {...props} />
    </FoldedSettingsSection>
  );
}

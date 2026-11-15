import type { EnvironmentId, MemoryVaultAccess } from "@t3tools/contracts";
import { BrainIcon } from "lucide-react";
import { useState } from "react";

import { memoryVaultEnvironment } from "../../state/memoryVaults";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { NameVaultDialog } from "../memoryVaults/NameVaultDialog";
import { ComposerControl } from "./ComposerControl";

const ACCESS_LABELS: Record<MemoryVaultAccess, string> = {
  "read-write": "Read and update",
  "read-only": "Read only",
  reference: "Reference only",
};

const NO_VAULT = "__none__";
const DEFAULT = "__default__";

/**
 * The thread's memory vault. It is chosen apart from the project: picking one never changes the
 * thread's folder, branch, or files.
 */
export function MemoryVaultPicker({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const query = useEnvironmentQuery(
    memoryVaultEnvironment.overview({ environmentId, input: { threadId } }),
  );
  const select = useAtomCommand(memoryVaultEnvironment.select);
  const manage = useAtomCommand(memoryVaultEnvironment.manage);
  const [creating, setCreating] = useState(false);
  const overview = query.data;
  if (overview === null || !overview.settings.enabled) return null;

  const selection = overview.selection;
  const current = overview.vaults.find((vault) => vault.id === selection?.vaultId);
  const label = current ? current.name : "No vault";
  const choose = async (input: {
    vaultId?: string | null;
    access?: MemoryVaultAccess;
    reset?: boolean;
  }) => {
    await select({ environmentId, input: { threadId, ...input } });
    query.refresh();
  };
  const create = async (name: string | null) => {
    setCreating(false);
    if (!name) return;
    const result = await manage({ environmentId, input: { action: "create", name } });
    if (result._tag === "Success" && result.value.vaultId) {
      await choose({ vaultId: result.value.vaultId });
    }
  };

  return (
    <>
      {creating ? (
        <NameVaultDialog
          title="New memory vault"
          description="Notes in a vault are stored in Continuum's data folder, not in this project."
          onDone={(name) => void create(name)}
        />
      ) : null}
      <Menu>
        <MenuTrigger
          render={<ComposerControl size="xs" />}
          aria-label={`Memory vault: ${label}`}
          className="min-w-0 max-w-[40%] flex-initial justify-start"
        >
          <BrainIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{label}</span>
        </MenuTrigger>
        <MenuPopup align="end" side="top" className="w-[min(18rem,calc(100vw-2rem))]">
          <MenuGroup>
            <MenuGroupLabel>Memory vault (separate from the workspace)</MenuGroupLabel>
            <MenuRadioGroup
              value={selection?.inherited ? DEFAULT : (selection?.vaultId ?? NO_VAULT)}
              onValueChange={(value) =>
                void (value === DEFAULT
                  ? choose({ reset: true })
                  : choose({ vaultId: value === NO_VAULT ? null : value }))
              }
            >
              <MenuRadioItem value={DEFAULT} closeOnClick>
                Use default
                {overview.settings.defaultVaultId
                  ? ` (${overview.vaults.find((vault) => vault.id === overview.settings.defaultVaultId)?.name ?? "missing"})`
                  : " (none)"}
              </MenuRadioItem>
              {overview.vaults.map((vault) => (
                <MenuRadioItem key={vault.id} value={vault.id} closeOnClick>
                  <span className="min-w-0 truncate">{vault.name}</span>
                </MenuRadioItem>
              ))}
              <MenuRadioItem value={NO_VAULT} closeOnClick>
                No vault
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuItem onClick={() => setCreating(true)}>+ Create new vault</MenuItem>
          {current ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>This thread may</MenuGroupLabel>
                <MenuRadioGroup
                  value={selection?.access ?? "read-write"}
                  onValueChange={(value) => void choose({ access: value as MemoryVaultAccess })}
                >
                  {(Object.keys(ACCESS_LABELS) as Array<MemoryVaultAccess>).map((access) => (
                    <MenuRadioItem key={access} value={access} closeOnClick>
                      {ACCESS_LABELS[access]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </>
  );
}

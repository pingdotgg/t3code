import type { ContextMenuItem, ForkRolesListResult } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type ForkRoleMenuId = "role" | "role:none" | `role:set:${string}`;

export interface ForkRoleMenuState {
  readonly current: string | null;
  /** Null until the environment answers, or when it cannot list roles. */
  readonly list: ForkRolesListResult | null;
}

export function forkRoleMenuItems(
  state: ForkRoleMenuState | undefined,
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<ForkRoleMenuId>> {
  if (state === undefined) return [];
  const roles = state.list?.roles ?? [];
  const hint =
    state.list?.directory == null
      ? resolve(msg("Set a roles directory in Settings"))
      : roles.length === 0
        ? resolve(msg("No roles in the roles directory"))
        : undefined;
  return [
    {
      id: "role",
      label: resolve(msg("Role", { $context: "submenu: the standing job a thread runs" })),
      icon: "bot",
      ...(hint === undefined
        ? {
            children: [
              ...roles.map((role) => ({
                id: `role:set:${role.id}` as const,
                label: role.name,
                checked: role.id === state.current,
              })),
              ...(state.current === null
                ? []
                : [
                    {
                      id: "role:none" as const,
                      label: resolve(msg("No role")),
                      separatorBefore: roles.length > 0,
                    },
                  ]),
            ],
          }
        : { disabled: true, detail: hint }),
    },
  ];
}

/** The role a menu id picks: a role id, null for "No role", undefined for any other id. */
export function forkRoleFromMenuId(id: string): string | null | undefined {
  if (id === "role:none") return null;
  return id.startsWith("role:set:") ? id.slice("role:set:".length) : undefined;
}

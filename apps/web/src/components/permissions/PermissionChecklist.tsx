import { T, useGT } from "gt-react";
import { CircleCheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../ui/button";
import { definePluginComponent } from "~/plugins/features";

export const PermissionChecklist = definePluginComponent(
  "component:components/permissions/PermissionChecklist/PermissionChecklist",
  PluginOriginalPermissionChecklist,
);
export const PermissionContinueButton = definePluginComponent(
  "component:components/permissions/PermissionChecklist/PermissionContinueButton",
  PluginOriginalPermissionContinueButton,
);

export interface PermissionItem {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  granted: boolean;
  onAllow: () => void;
}

function PluginOriginalPermissionChecklist({
  permissions,
  busy = false,
}: {
  permissions: readonly PermissionItem[];
  busy?: boolean;
}) {
  return (
    <div className="space-y-2">
      {permissions.map((permission) => (
        <div key={permission.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
          {permission.icon}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{permission.title}</p>
            <p className="text-xs text-muted-foreground">{permission.description}</p>
          </div>
          {permission.granted ? (
            <span role="status" className="flex items-center gap-1 text-xs text-success">
              <CircleCheckIcon className="size-4" aria-hidden="true" />
              <T context="permission status">Allowed</T>
            </span>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={permission.onAllow}>
              <T context="verb, grant a permission">Allow</T>
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function PluginOriginalPermissionContinueButton({
  ready,
  busy = false,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "disabled"> & { ready: boolean; busy?: boolean }) {
  const gt = useGT();
  return (
    <Button {...props} disabled={!ready || busy}>
      {children ?? gt("Continue")}
    </Button>
  );
}

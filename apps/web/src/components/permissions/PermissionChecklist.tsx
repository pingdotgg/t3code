import { CircleCheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../ui/button";

export interface PermissionItem {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  granted: boolean;
  onAllow: () => void;
}

const DEFAULT_PERMISSION_LABELS = { allowed: "Allowed", allow: "Allow" } as const;

export function PermissionChecklist({
  permissions,
  busy = false,
  labels = DEFAULT_PERMISSION_LABELS,
}: {
  permissions: readonly PermissionItem[];
  busy?: boolean;
  labels?: { readonly allowed: string; readonly allow: string };
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
              {labels.allowed}
            </span>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={permission.onAllow}>
              {labels.allow}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function PermissionContinueButton({
  ready,
  busy = false,
  children = "Continue",
  ...props
}: Omit<ComponentProps<typeof Button>, "disabled"> & { ready: boolean; busy?: boolean }) {
  return (
    <Button {...props} disabled={!ready || busy}>
      {children}
    </Button>
  );
}

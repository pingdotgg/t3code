import {
  type EnvironmentId,
  localVaultReference,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function VaultTokenPicker({
  environmentId,
  value,
  onValueChange,
  label,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: string;
  readonly onValueChange: (reference: string) => void;
  readonly label: string;
  readonly disabled?: boolean | undefined;
}) {
  const gt = useGT();
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    allowed ? serverEnvironment.localVault({ environmentId, input: {} }) : null,
  );
  const entries = (query.data?.entries ?? []).filter((entry) => entry.kind === "token");
  const selected = entries.find((entry) => localVaultReference(entry.name, "token") === value);
  const error = query.error ?? query.data?.error;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Select
          value={value || null}
          disabled={disabled || !allowed || query.isPending}
          onValueChange={(next) => {
            if (next) onValueChange(next);
          }}
        >
          <SelectTrigger className="min-w-0 flex-1" aria-label={label}>
            <SelectValue placeholder={gt("Choose a saved API token")}>
              {selected?.title ?? (value ? gt("Saved entry unavailable") : undefined)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {value && !selected ? (
              <SelectItem value={value} disabled>
                {gt("Saved entry unavailable")}
              </SelectItem>
            ) : null}
            {entries.map((entry) => (
              <SelectItem
                key={entry.name}
                value={localVaultReference(entry.name, "token")}
                disabled={entry.access !== "allow"}
              >
                {entry.title}
                {entry.access !== "allow" ? ` · ${gt("PIN required")}` : ""}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          disabled={disabled || !allowed || query.isPending}
          aria-label={gt("Refresh vault entries")}
          onClick={() => query.refresh()}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>
      {entries.some((entry) => entry.access !== "allow") ? (
        <p className="text-xs text-muted-foreground">
          {gt(
            "For provider use, open this token in Secrets and enable Allow protected use with your PIN.",
          )}
        </p>
      ) : null}
      {!allowed ? (
        <p className="text-xs text-muted-foreground">
          {gt("You need settings permission to browse this vault.")}
        </p>
      ) : error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : !entries.length && !query.isPending ? (
        <p className="text-xs text-muted-foreground">
          {gt("No API tokens saved yet.")}{" "}
          <Link to="/settings/secrets" className="underline underline-offset-2">
            {gt("Manage vault")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

import { useGT } from "gt-react";
import { LockKeyholeIcon } from "lucide-react";

export function VaultMentionChip({ label }: { readonly label: string }) {
  const gt = useGT();
  return (
    <span
      data-vault-mention
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-warning-surface px-1.5 align-baseline font-medium text-warning-foreground"
      role="img"
      aria-label={gt("Vault credential: {label}", { label })}
    >
      <LockKeyholeIcon className="size-[0.83em] shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

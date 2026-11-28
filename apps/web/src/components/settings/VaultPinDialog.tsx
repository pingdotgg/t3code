import { useId, useState } from "react";
import { useGT } from "gt-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function VaultPinField({
  value,
  onChange,
  disabled,
  label,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly label?: string;
}) {
  const gt = useGT(),
    id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label ?? gt("Vault PIN")}</Label>
      <Input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        pattern="[0-9]{6,8}"
        minLength={6}
        maxLength={8}
        required
      />
    </div>
  );
}
export function VaultPinSetupDialog({
  configured,
  onClose,
  onSave,
}: {
  readonly configured: boolean;
  readonly onClose: () => void;
  readonly onSave: (pin: string, oldPin: string) => Promise<string | null>;
}) {
  const gt = useGT(),
    form = useId();
  const [pin, setPin] = useState(""),
    [confirm, setConfirm] = useState(""),
    [oldPin, setOldPin] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{configured ? gt("Change vault PIN") : gt("Set vault PIN")}</DialogTitle>
          <DialogDescription>
            {gt(
              "Use 6 to 8 digits. This confirms vault actions in Hyakki, not protection from programs running as your Linux user.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={form}
            className="grid gap-4"
            autoComplete="off"
            onSubmit={async (e) => {
              e.preventDefault();
              if (pending) return;
              if (pin !== confirm) {
                setError(gt("The PINs do not match."));
                return;
              }
              setPending(true);
              setError(null);
              const next = pin,
                current = oldPin;
              setPin("");
              setConfirm("");
              setOldPin("");
              await (async () => {
                const error = await onSave(next, current);
                if (error) setError(error);
                else onClose();
              })().finally(() => {
                setPending(false);
              });
            }}
          >
            {configured ? (
              <VaultPinField
                value={oldPin}
                onChange={setOldPin}
                disabled={pending}
                label={gt("Current PIN")}
              />
            ) : null}
            <VaultPinField value={pin} onChange={setPin} disabled={pending} label={gt("New PIN")} />
            <VaultPinField
              value={confirm}
              onChange={setConfirm}
              disabled={pending}
              label={gt("Confirm new PIN")}
            />
            <p className="text-xs text-muted-foreground">
              {gt(
                "Five incorrect attempts start a persistent cooldown. First setup clears pending credential approvals. PIN changes invalidate pending vault approvals, but cannot retract fields already delivered to an agent or provider.",
              )}
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button
            type="submit"
            form={form}
            disabled={
              pending || pin.length < 6 || confirm.length < 6 || (configured && oldPin.length < 6)
            }
          >
            {pending ? gt("Saving…") : configured ? gt("Change PIN") : gt("Set PIN")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
export function VaultPinConfirmDialog({
  title,
  description,
  submitLabel,
  onClose,
  onConfirm,
}: {
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly onClose: () => void;
  readonly onConfirm: (pin: string) => Promise<string | null>;
}) {
  const gt = useGT(),
    form = useId();
  const [pin, setPin] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={form}
            className="grid gap-3"
            autoComplete="off"
            onSubmit={async (e) => {
              e.preventDefault();
              if (pending) return;
              setPending(true);
              setError(null);
              const entered = pin;
              setPin("");
              await (async () => {
                const error = await onConfirm(entered);
                if (error) setError(error);
                else onClose();
              })().finally(() => {
                setPending(false);
              });
            }}
          >
            <VaultPinField value={pin} onChange={setPin} disabled={pending} />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button type="submit" form={form} disabled={pending || pin.length < 6}>
            {pending ? gt("Confirming…") : submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

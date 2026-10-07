import { useState } from "react";
import type { ProviderAuthMethod } from "@t3tools/contracts";
import { RadioGroup, Radio } from "../ui/radio-group";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";

export function ChatGptAccountPicker({
  open,
  methods,
  onClose,
  onSelect,
}: {
  open: boolean;
  methods: readonly ProviderAuthMethod[];
  onClose: () => void;
  onSelect: (methodId: string) => void;
}) {
  const profiles = methods.filter((method) => method.id.startsWith("chatgpt-profile:"));
  const [selection, setSelection] = useState<string | null>(null);
  const selectedMethodId =
    selection === "chatgpt-change-account"
      ? selection
      : (profiles.find((profile) => profile.id === selection)?.id ??
        profiles[0]?.id ??
        "chatgpt-change-account");
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Reconnect ChatGPT</DialogTitle>
          <DialogDescription>
            On OpenAI, sign in with the account you choose here.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-6">
          <RadioGroup
            aria-label="ChatGPT account to connect"
            value={selectedMethodId}
            onValueChange={(value) => setSelection(value)}
          >
            {profiles.map((profile) => (
              <label
                key={profile.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm"
              >
                <Radio value={profile.id} />
                <span className="min-w-0 break-all font-medium">{profile.name}</span>
              </label>
            ))}
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm">
              <Radio value="chatgpt-change-account" />
              <span className="font-medium">Use a different account</span>
            </label>
          </RadioGroup>
        </div>
        <DialogFooter>
          <ChatGptConnectionButton onClick={() => onSelect(selectedMethodId)} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

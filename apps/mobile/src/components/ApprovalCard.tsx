import { useState } from "react";
import { View } from "react-native";
import type { Approval } from "../../../../packages/protocol/src/index.ts";
import { AppText as Text } from "./AppText";
import { RequestActionButton } from "./RequestActionButton";

/** Retains T3's approval card presentation with our own request interface. */
export function ApprovalCard({ approval, connected, onRespond }: {
  approval: Approval; connected: boolean; onRespond: (decision: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
    <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">Approval needed</Text>
    <Text className="font-t3-bold text-lg text-foreground">{approval.method.includes("fileChange") ? "File changes" : "Run command"}</Text>
    <Text selectable className="font-mono text-sm leading-normal text-foreground-secondary">{approval.detail}</Text>
    <View className="flex-row gap-2">
      {approval.choices.map((decision) => <RequestActionButton key={decision}
        label={decision === "accept" ? "Allow once" : decision === "decline" ? "Decline" : "Cancel"}
        tone={decision === "accept" ? "primary" : "secondary"} disabled={busy || !connected}
        onPress={() => { setBusy(true); void onRespond(decision).finally(() => setBusy(false)); }} />)}
    </View>
  </View>;
}

import { requireNativeView } from "expo";
import { useMemo, useState } from "react";
import { ScrollView, View, type ViewProps } from "react-native";
import type { ComponentType } from "react";
import { AppText as Text } from "./AppText";
import { RequestActionButton } from "./RequestActionButton";

interface TerminalProps extends ViewProps {
  terminalKey: string; initialBuffer: string; autoFocus: boolean; fontSize: number;
  appearanceScheme: "dark"; backgroundColor: string; foregroundColor: string;
}
/** Reuses T3's Android Ghostty renderer for agent command output, without a PTY SDK. */
export function TerminalOutput({ id, output }: { id: string; output: string }) {
  const [expanded, setExpanded] = useState(false);
  const Terminal = useMemo(() => {
    try { return requireNativeView<TerminalProps>("T3TerminalSurface") as ComponentType<TerminalProps>; }
    catch { return null; }
  }, []);
  return <View className="gap-2">
    <RequestActionButton tone="secondary" label={expanded ? "Collapse output" : "Expand output"} onPress={() => setExpanded(!expanded)} />
    <View className="overflow-hidden rounded-2xl bg-zinc-950" style={{ height: expanded ? 500 : 200 }}>
    {Terminal ? <Terminal terminalKey={id} initialBuffer={output.replace(/(?<!\r)\n/g, "\r\n")}
      autoFocus={false} fontSize={13} appearanceScheme="dark" backgroundColor="#09090b" foregroundColor="#fafafa"
      style={{ flex: 1 }} />
      : <ScrollView nestedScrollEnabled><ScrollView horizontal><Text selectable className="p-3 font-mono text-xs text-zinc-100">{output}</Text></ScrollView></ScrollView>}
    </View>
  </View>;
}

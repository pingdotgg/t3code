import { SheetHeader } from "../../components/ui/SheetHeader";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { FitSheet } from "../../components/ui/FitSheet";

export function PullRequestSheetContent(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly busy?: boolean;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  const navigation = useNavigation();
  return (
    <FitSheet
      avoidsKeyboard
      header={
        <SheetHeader
          title={props.title}
          subtitle={props.subtitle}
          onCancel={() => navigation.goBack()}
          dismissDisabled={props.busy}
        />
      }
      footer={props.footer}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20 }}
    >
      <View className="gap-4" pointerEvents={props.busy ? "none" : "auto"}>
        {props.children}
      </View>
    </FitSheet>
  );
}

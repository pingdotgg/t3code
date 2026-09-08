import type {
  EnvironmentId,
  UserInputAttachmentAnswerPayload,
  UserInputAttachments,
} from "@t3tools/contracts";
import { Image, Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useAssetUrl } from "../../state/assets";

function AnswerFile(props: {
  environmentId: EnvironmentId;
  attachment: UserInputAttachments[string][number];
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachment.id,
  });
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.attachment.name}
      disabled={!url}
      onPress={() => {
        if (url) void Linking.openURL(url);
      }}
      className="gap-1"
    >
      {props.attachment.type === "image" && url ? (
        <Image source={{ uri: url }} style={{ width: 160, height: 96 }} resizeMode="contain" />
      ) : null}
      <Text className="text-sm text-foreground underline">{props.attachment.name}</Text>
    </Pressable>
  );
}

export function QuestionAnswerHistory(props: {
  environmentId: EnvironmentId;
  answer: UserInputAttachmentAnswerPayload;
}) {
  return (
    <View className="gap-2">
      {[
        ...new Set([
          ...Object.keys(props.answer.answers),
          ...Object.keys(props.answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <View key={questionId} className="gap-1">
          {props.answer.questionTextById?.[questionId] ? (
            <Text className="text-sm text-foreground-muted">
              {props.answer.questionTextById[questionId]}
            </Text>
          ) : null}
          <Text className="text-sm text-foreground">
            {[props.answer.answers[questionId]]
              .flat()
              .filter((value): value is string => typeof value === "string")
              .join(", ")}
          </Text>
          {(props.answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => (
            <AnswerFile
              key={attachment.id}
              environmentId={props.environmentId}
              attachment={attachment}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

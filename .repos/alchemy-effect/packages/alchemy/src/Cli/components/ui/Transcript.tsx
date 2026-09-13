/** @jsxImportSource react */
import { useGlyphs } from "./Environment.tsx";
import { Stack } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

type AnsweredPromptProps = {
  readonly message: string;
  readonly answer: string;
  readonly below?: boolean;
};

export function AnsweredPrompt({
  message,
  answer,
  below = false,
}: AnsweredPromptProps) {
  const glyphs = useGlyphs();
  return below ? (
    <Stack>
      <Text>
        <Text tone="success">{glyphs.success}</Text> {message}
      </Text>
      <Text tone="muted"> {answer}</Text>
    </Stack>
  ) : (
    <Text>
      <Text tone="success">{glyphs.success}</Text> {message}{" "}
      <Text tone="muted">· {answer}</Text>
    </Text>
  );
}

type CancelledPromptProps = { readonly message: string };

export function CancelledPrompt({ message }: CancelledPromptProps) {
  const glyphs = useGlyphs();
  return (
    <Text tone="muted">
      <Text tone="danger">{glyphs.error}</Text> {message} cancelled
    </Text>
  );
}

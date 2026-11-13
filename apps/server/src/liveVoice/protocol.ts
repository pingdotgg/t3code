import * as Schema from "effect/Schema";

export const VoiceEvent = Schema.Struct({
  type: Schema.String,
  turn: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      transcript: Schema.optionalKey(Schema.String),
    }),
  ),
  item: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      type: Schema.optionalKey(Schema.String),
      target: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
        ),
      ),
    }),
  ),
});
export type VoiceEvent = typeof VoiceEvent.Type;

export function voiceDelegation(event: VoiceEvent) {
  const item = event.item;
  if (
    event.type !== "delegation.created" ||
    item?.type !== "delegation" ||
    item.target !== "client" ||
    !item.id
  )
    return null;
  const text = item.content
    ?.filter((part) => part.type === "input_text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  return text && text.length <= 16_384 ? { id: item.id, text } : null;
}

export function voiceContextChunks(text: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const length = encoder.encode(character).length;
    if (bytes + length > 480) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

import * as Clipboard from "expo-clipboard";

export type TerminalClipboardReadResult =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "empty" }
  | { readonly _tag: "unavailable"; readonly cause: unknown };

/**
 * Reads text only after an explicit terminal paste action. Keeping clipboard
 * access behind the button avoids surprising iOS paste prompts while still
 * giving both native terminal surfaces the same behavior.
 */
export async function readTerminalClipboardText(): Promise<TerminalClipboardReadResult> {
  try {
    if (!(await Clipboard.hasStringAsync())) {
      return { _tag: "empty" };
    }

    const text = await Clipboard.getStringAsync();
    return text.length === 0 ? { _tag: "empty" } : { _tag: "text", text };
  } catch (cause) {
    return { _tag: "unavailable", cause };
  }
}

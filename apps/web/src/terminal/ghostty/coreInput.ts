import { ghosttyConsumedMods, ghosttyKeyForEvent, ghosttyUnshiftedCodepoint } from "./keyCodes";
import { GHOSTTY_OUT_OF_SPACE, GHOSTTY_SUCCESS } from "./coreLayout";
import { decoder, encoder } from "./coreText";
import { GhosttyMouseInput, GhosttyTerminalCore } from "./core";

export function coreEncodeKey(
  core: GhosttyTerminalCore,
  event: KeyboardEvent,
  action: "press" | "release" = "press",
) {
  core.ensureActive();
  core.runtime.call("ghostty_key_encoder_setopt_from_terminal", core.keyEncoder, core.terminal);
  core.runtime.call(
    "ghostty_key_event_set_action",
    core.keyEvent,
    action === "release" ? 0 : event.repeat ? 2 : 1,
  );
  core.runtime.call("ghostty_key_event_set_key", core.keyEvent, ghosttyKeyForEvent(event));
  const mods =
    (event.shiftKey ? 1 : 0) |
    (event.ctrlKey ? 1 << 1 : 0) |
    (event.altKey ? 1 << 2 : 0) |
    (event.metaKey ? 1 << 3 : 0) |
    (event.getModifierState("CapsLock") ? 1 << 4 : 0) |
    (event.getModifierState("NumLock") ? 1 << 5 : 0);
  core.runtime.call("ghostty_key_event_set_mods", core.keyEvent, mods);
  core.runtime.call(
    "ghostty_key_event_set_consumed_mods",
    core.keyEvent,
    ghosttyConsumedMods(event),
  );
  core.runtime.call("ghostty_key_event_set_composing", core.keyEvent, event.isComposing ? 1 : 0);
  core.runtime.call(
    "ghostty_key_event_set_unshifted_codepoint",
    core.keyEvent,
    ghosttyUnshiftedCodepoint(event, core.keyboardLayoutMap),
  );

  const text = event.key.length === 1 ? event.key : "";
  const textBytes = encoder.encode(text);
  const textPointer = textBytes.length === 0 ? 0 : core.runtime.alloc(textBytes.length);
  if (textPointer !== 0) core.runtime.bytes(textPointer, textBytes.length).set(textBytes);
  core.runtime.call("ghostty_key_event_set_utf8", core.keyEvent, textPointer, textBytes.length);

  const written = core.runtime.call("ghostty_wasm_alloc_usize");
  const encoded = core.encodeOutput(written, (output, outputSize) =>
    core.runtime.call(
      "ghostty_key_encoder_encode",
      core.keyEncoder,
      core.keyEvent,
      output,
      outputSize,
      written,
    ),
  );
  core.runtime.call("ghostty_wasm_free_usize", written);
  if (textPointer !== 0) core.runtime.free(textPointer, textBytes.length);
  return encoded;
}
export function coreEncodePaste(core: GhosttyTerminalCore, data: string) {
  core.ensureActive();
  const input = encoder.encode(data);
  if (input.length === 0) return "";
  const inputPointer = core.runtime.alloc(input.length);
  core.runtime.bytes(inputPointer, input.length).set(input);
  core.runtime.bytes(core.scratch, 1)[0] = 0;
  const bracketed =
    core.runtime.call("ghostty_terminal_mode_get", core.terminal, 2004, core.scratch) ===
      GHOSTTY_SUCCESS && core.runtime.bytes(core.scratch, 1)[0] !== 0;
  const written = core.runtime.call("ghostty_wasm_alloc_usize");
  let encoded = "";
  const sizeResult = core.runtime.call(
    "ghostty_paste_encode",
    inputPointer,
    input.length,
    bracketed ? 1 : 0,
    0,
    0,
    written,
  );
  const outputSize = core.runtime.view(written, 4).getUint32(0, true);
  if (sizeResult === GHOSTTY_OUT_OF_SPACE && outputSize > 0) {
    const output = core.runtime.alloc(outputSize);
    const result = core.runtime.call(
      "ghostty_paste_encode",
      inputPointer,
      input.length,
      bracketed ? 1 : 0,
      output,
      outputSize,
      written,
    );
    const outputLength = core.runtime.view(written, 4).getUint32(0, true);
    encoded =
      result === GHOSTTY_SUCCESS ? decoder.decode(core.runtime.bytes(output, outputLength)) : "";
    core.runtime.free(output, outputSize);
  }
  core.runtime.call("ghostty_wasm_free_usize", written);
  core.runtime.free(inputPointer, input.length);
  return encoded;
}
export function coreEncodeMouse(core: GhosttyTerminalCore, input: GhosttyMouseInput) {
  core.ensureActive();
  core.runtime.call("ghostty_mouse_encoder_setopt_from_terminal", core.mouseEncoder, core.terminal);

  const sizeLayout = core.runtime.layout("GhosttyMouseEncoderSize");
  const size = core.runtime.alloc(sizeLayout.size);
  for (const [field, value] of [
    ["size", sizeLayout.size],
    ["screen_width", input.screenWidth],
    ["screen_height", input.screenHeight],
    ["cell_width", input.cellWidth],
    ["cell_height", input.cellHeight],
    ["padding_top", input.paddingTop],
    ["padding_bottom", input.paddingBottom],
    ["padding_right", input.paddingRight],
    ["padding_left", input.paddingLeft],
  ] as const) {
    core.runtime.setField(size, "GhosttyMouseEncoderSize", field, Math.max(0, Math.round(value)));
  }
  core.runtime.call("ghostty_mouse_encoder_setopt", core.mouseEncoder, 2, size);
  core.runtime.free(size, sizeLayout.size);

  core.runtime.bytes(core.scratch, 1)[0] = input.anyButtonPressed ? 1 : 0;
  core.runtime.call("ghostty_mouse_encoder_setopt", core.mouseEncoder, 3, core.scratch);
  core.runtime.bytes(core.scratch, 1)[0] = 1;
  core.runtime.call("ghostty_mouse_encoder_setopt", core.mouseEncoder, 4, core.scratch);

  core.runtime.call(
    "ghostty_mouse_event_set_action",
    core.mouseEvent,
    input.action === "press" ? 0 : input.action === "release" ? 1 : 2,
  );
  if (input.button === null) {
    core.runtime.call("ghostty_mouse_event_clear_button", core.mouseEvent);
  } else {
    core.runtime.call("ghostty_mouse_event_set_button", core.mouseEvent, input.button);
  }
  core.runtime.call("ghostty_mouse_event_set_mods", core.mouseEvent, input.mods);
  const positionLayout = core.runtime.layout("GhosttyMousePosition");
  const position = core.runtime.alloc(positionLayout.size);
  const positionView = core.runtime.view(position, positionLayout.size);
  positionView.setFloat32(positionLayout.fields.x!.offset, input.x, true);
  positionView.setFloat32(positionLayout.fields.y!.offset, input.y, true);
  core.runtime.call("ghostty_mouse_event_set_position", core.mouseEvent, position);
  core.runtime.free(position, positionLayout.size);

  const written = core.runtime.call("ghostty_wasm_alloc_usize");
  const encoded = core.encodeOutput(written, (output, outputSize) =>
    core.runtime.call(
      "ghostty_mouse_encoder_encode",
      core.mouseEncoder,
      core.mouseEvent,
      output,
      outputSize,
      written,
    ),
  );
  core.runtime.call("ghostty_wasm_free_usize", written);
  return encoded;
}

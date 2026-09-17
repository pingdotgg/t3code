import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { readKdlNodes, type KdlNode } from "./captureConfigKdl.ts";
import { niriCaptureBinding } from "./linuxCaptureSession.ts";

export type CaptureConfigFormat = "niri" | "hyprland" | "hyprland-lua";

export function captureConfigKeys(input = "Ctrl+Shift+2") {
  const keys = parseKeybindingShortcut(input.replace(/super/gi, "meta"));
  if (
    !keys ||
    keys.modKey ||
    !/^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4]))$/.test(keys.key) ||
    !(keys.ctrlKey || keys.altKey || keys.metaKey)
  )
    throw new Error("Choose a letter, number, or function key with Ctrl, Alt, or Super.");
  const modifiers = [
    keys.ctrlKey && "Ctrl",
    keys.altKey && "Alt",
    keys.shiftKey && "Shift",
    keys.metaKey && "Super",
  ].filter(Boolean);
  return {
    label: [...modifiers, keys.key.toUpperCase()].join("+"),
    modifiers: modifiers.map((key) => String(key).toUpperCase()).join(" "),
    key: keys.key.toUpperCase(),
    mask:
      (keys.shiftKey ? 1 : 0) |
      (keys.ctrlKey ? 4 : 0) |
      (keys.altKey ? 8 : 0) |
      (keys.metaKey ? 64 : 0),
  };
}

function sameKeys(left: string, right: string) {
  try {
    return captureConfigKeys(left).label === captureConfigKeys(right).label;
  } catch {
    return false;
  }
}

export function captureConfigBinding(format: CaptureConfigFormat, appId: string, keys: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(appId)) throw new Error("Invalid capture application ID.");
  const chord = captureConfigKeys(keys);
  if (format === "niri") return niriCaptureBinding(appId).replace("Ctrl+Shift+2", chord.label);
  const action = `${appId}:capture-window`;
  return format === "hyprland-lua"
    ? `hl.bind("${chord.label.toUpperCase().replaceAll("+", " + ")}", hl.dsp.global("${action}"))`
    : `bind = ${chord.modifiers}, ${chord.key}, global, ${action}`;
}

function niriBinds(source: string) {
  const blocks = readKdlNodes(source).filter((node) => node.name === "binds");
  if (blocks.length > 1 || blocks.some((node) => node.close === undefined))
    throw new Error("This Niri config has an unexpected binds section. Check it in Advanced.");
  return blocks[0];
}

function niriCaptureNode(node: KdlNode, appId: string) {
  const expected = readKdlNodes(captureConfigBinding("niri", appId, "Ctrl+Shift+2"))[0]!
    .children[0]!;
  const action = node.children[0];
  return (
    node.children.length === 1 &&
    action?.children.length === 0 &&
    JSON.stringify(action.header.map((token) => token.value)) ===
      JSON.stringify(expected.header.map((token) => token.value))
  );
}

function hyprlandBinds(source: string, lua: boolean) {
  const bindings: { start: number; end: number; keys: string; action: string }[] = [];
  let start = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const legacy =
      !lua &&
      /^\s*bind[a-z]*\s*=\s*([^,]*),\s*([^,]*),\s*([^,]*),\s*(.*?)\s*(?:#.*)?$/.exec(
        line.trimEnd(),
      );
    const modern =
      lua &&
      /^\s*hl\.bind\(\s*(["'])(.*?)\1\s*,\s*hl\.dsp\.global\(\s*(["'])(.*?)\3\s*\)\s*\)\s*;?\s*(?:--.*)?$/.exec(
        line.trimEnd(),
      );
    if (legacy)
      bindings.push({
        start,
        end: start + line.length,
        keys: `${legacy[1]!.trim().replace(/\s+/g, "+")}+${legacy[2]!.trim()}`,
        action: legacy[3]!.trim() === "global" ? legacy[4]!.trim() : "",
      });
    if (modern)
      bindings.push({ start, end: start + line.length, keys: modern[2]!, action: modern[4]! });
    start += line.length;
  }
  return bindings;
}

export function niriConfigIncludes(source: string) {
  return readKdlNodes(source)
    .filter((node) => node.name === "include")
    .map((node) => {
      const path = node.header.find(
        (token, index) => index > 0 && token.quoted && node.header[index - 1]?.value !== "=",
      )?.value;
      if (!path) throw new Error("Couldn't resolve a Niri include. Choose the config in Advanced.");
      const optional = node.header.some(
        (token, index) =>
          token.value === "optional" &&
          node.header[index + 1]?.value === "=" &&
          node.header[index + 2]?.value === "true",
      );
      return { path, optional };
    });
}

export function niriConfigConflict(source: string, appId: string, keys: string) {
  return (
    niriBinds(source)?.children.some(
      (node) => sameKeys(node.name, keys) && !niriCaptureNode(node, appId),
    ) ?? false
  );
}

function removeNodes(source: string, ranges: { start: number; end: number }[]) {
  let result = source;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    const lineStart = source.lastIndexOf("\n", range.start - 1) + 1;
    const nextLine = source.indexOf("\n", range.end);
    const lineEnd = nextLine < 0 ? source.length : nextLine;
    const wholeLine =
      !source.slice(lineStart, range.start).trim() && !source.slice(range.end, lineEnd).trim();
    result =
      result.slice(0, wholeLine ? lineStart : range.start) +
      result.slice(wholeLine ? Math.min(lineEnd + 1, source.length) : range.end);
  }
  return result;
}

export function editCaptureConfig(
  source: string,
  format: CaptureConfigFormat,
  appId: string,
  operation: "install" | "remove",
  requestedKeys?: string,
) {
  if (format === "hyprland-lua" && (/^\s*return\b/m.test(source) || /\[=*\[/.test(source)))
    throw new Error(
      "This Lua config needs a manual edit. Choose your bindings file or use manual setup in Advanced.",
    );
  const niri = format === "niri";
  const existing = niri
    ? (niriBinds(source)?.children ?? [])
        .filter((node) => niriCaptureNode(node, appId))
        .map((node) => ({ ...node, keys: node.name }))
    : hyprlandBinds(source, format === "hyprland-lua").filter(
        (bind) => bind.action === `${appId}:capture-window`,
      );
  const keys = captureConfigKeys(requestedKeys ?? existing[0]?.keys).label;
  if (operation === "install" && existing.length === 1 && sameKeys(existing[0]!.keys, keys))
    return { after: source, shortcut: keys };
  let after = removeNodes(source, existing);
  if (operation === "remove") return { after, shortcut: keys };
  const conflict = niri
    ? niriConfigConflict(after, appId, keys)
    : hyprlandBinds(after, false).some((bind) => sameKeys(bind.keys, keys));
  if (conflict) throw new Error(`${keys} is already used in this config. Choose another shortcut.`);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const binding = captureConfigBinding(format, appId, keys);
  if (niri) {
    const block = niriBinds(after);
    if (block?.close !== undefined) {
      const lineStart = after.lastIndexOf("\n", block.close - 1) + 1;
      const indent = after.slice(lineStart, block.close);
      if (!indent.trim())
        after =
          after.slice(0, lineStart) + indent + "    " + binding + newline + after.slice(lineStart);
      else
        after =
          after.slice(0, block.close) +
          newline +
          "    " +
          binding +
          newline +
          after.slice(block.close);
    } else
      after += `${after && !after.endsWith("\n") ? newline : ""}${newline}binds {${newline}    ${binding}${newline}}${newline}`;
    readKdlNodes(after);
  } else {
    // Do not append executable Lua inside a block/string, or after an early return.
    // The normal Omarchy binding file is a sequence of top-level hl.bind calls.
    after += `${after && !after.endsWith("\n") ? newline : ""}${newline}${binding}${newline}`;
  }
  return { after, shortcut: keys };
}

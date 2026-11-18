import { parseRightPanelMenuChoice, type WhiteboardPanelCapability } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value of `T3CODE_WHITEBOARD_PANEL`; undefined unless it is a JSON object. */
export function parseWhiteboardPanel(raw: string): WhiteboardPanelCapability | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const menu = isRecord(value.menu) ? value.menu : {};
  return {
    menu: Object.fromEntries(
      Object.entries(menu).flatMap(([id, entry]) => {
        const choice = parseRightPanelMenuChoice(entry);
        return choice === undefined ? [] : [[id, choice]];
      }),
    ),
  };
}

// The whiteboard's run-t3.sh sets the variable only on a board host, from its deploy-time config.
export const whiteboardPanelCapabilities = Effect.fn("whiteboardPanel.capabilities")(function* () {
  const raw = (yield* HostProcess.Environment).T3CODE_WHITEBOARD_PANEL;
  if (raw === undefined) return {};
  const whiteboardPanel = parseWhiteboardPanel(raw);
  if (whiteboardPanel === undefined) {
    yield* Effect.logWarning(
      "T3CODE_WHITEBOARD_PANEL is not a JSON object; the board panel is off",
    );
    return {};
  }
  return { whiteboardPanel };
});

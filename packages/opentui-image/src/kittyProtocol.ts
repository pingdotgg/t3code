const ESC = "\x1b";
const ST = `${ESC}\\`;

export type KittyProtocolTransport = "direct" | "tmux";

export function encodeKittyCommand(
  command: string,
  transport: KittyProtocolTransport = "direct",
): string {
  if (transport === "direct") return command;
  // tmux passthrough is a DCS payload prefixed with "tmux;". Every ESC in the
  // wrapped command must be doubled so tmux forwards it instead of parsing it.
  return `${ESC}Ptmux;${command.replaceAll(ESC, ESC + ESC)}${ST}`;
}

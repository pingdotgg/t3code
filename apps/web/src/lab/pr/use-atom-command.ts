// Mockup stub: commands (merge, comment, edit) succeed without reaching a server.
export * from "~/state/use-atom-command";
export function useAtomCommand(_command: unknown, _options?: unknown) {
  return async (_value: unknown) => ({ _tag: "Success", value: undefined }) as never;
}

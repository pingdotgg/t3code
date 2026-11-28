import type * as ChatInteraction from "effect/chat/ChatInteraction"

/** @internal */
export interface BotCommand {
  readonly command: string
  readonly description: string
}

/**
 * The `commands` of `setMyCommands` for a group's command definitions, or
 * the ids Telegram can't take: its names are `[a-z0-9_]{1,32}`. A
 * command's `argument` has no Telegram counterpart and is appended to its
 * description, cut to 256 characters.
 *
 * @internal
 */
export const botCommands = (
  group: ChatInteraction.Group<any>
): { readonly commands: ReadonlyArray<BotCommand> } | { readonly invalid: ReadonlyArray<string> } => {
  const commands: Array<BotCommand> = []
  const invalid: Array<string> = []
  for (const definition of (group.definitions as ReadonlyMap<string, ChatInteraction.Definition>).values()) {
    if (definition.kind !== "command") continue
    if (!/^[a-z0-9_]{1,32}$/.test(definition.id)) {
      invalid.push(definition.id)
      continue
    }
    const argument = definition.argument === undefined
      ? ""
      : ` <${definition.argument.name}${definition.argument.required ? "" : "?"}>: ${definition.argument.description}`
    commands.push({
      command: definition.id,
      description: Array.from(definition.description + argument).slice(0, 256).join("")
    })
  }
  return invalid.length > 0 ? { invalid } : { commands }
}

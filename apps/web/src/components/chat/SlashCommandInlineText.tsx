import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { BotIcon, TerminalIcon } from "lucide-react";

import type { ComposerSlashCommandLike } from "~/lib/composerSlashCommands";
import {
  formatComposerSlashCommandLabel,
  resolveComposerSlashCommandDescription,
} from "~/lib/composerSlashCommands";
import { AppLogoIcon } from "../AppLogoIcon";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import {
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import { cn } from "~/lib/utils";

const SLASH_COMMAND_TOKEN_REGEX = /(^|\s)\/([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

type InlineSlashCommand = ComposerSlashCommandLike;

export function SlashCommandInlineText(props: {
  text: string;
  slashCommands: ReadonlyArray<InlineSlashCommand>;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const commandsByName = new Map(props.slashCommands.map((command) => [command.name, command]));

  for (const match of props.text.matchAll(SLASH_COMMAND_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `/${name}`;
    const command = commandsByName.get(name);
    if (!command) {
      continue;
    }

    if (start > cursor) {
      nodes.push(props.text.slice(cursor, start));
    }
    nodes.push(<SlashCommandChip key={`${start}:${name}`} command={command} rawText={rawText} />);
    cursor = start + rawText.length;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSlashCommandInlineMarkdownChildren(
  children: ReactNode,
  slashCommands: ReadonlyArray<InlineSlashCommand>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SlashCommandInlineText text={child} slashCommands={slashCommands} />;
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }
    if (child.type === "code" || child.type === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSlashCommandInlineMarkdownChildren(child.props.children, slashCommands),
    );
  });
}

function SlashCommandChip(props: { command: InlineSlashCommand; rawText: string }) {
  const description = resolveComposerSlashCommandDescription(props.command);
  const ProviderIcon = props.command.provider
    ? (PROVIDER_ICON_BY_PROVIDER[props.command.provider] ?? null)
    : null;
  const showAppIcon = props.command.sourceKind === "custom";
  const showAgentIcon = props.command.sourceKind === "agents";

  return (
    <span
      className="inline-flex align-middle leading-none"
      data-markdown-copy={props.rawText}
      title={description ?? undefined}
    >
      <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME)}>
        {showAppIcon ? (
          <AppLogoIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
        ) : showAgentIcon ? (
          <BotIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
        ) : ProviderIcon ? (
          <ProviderIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
        ) : (
          <TerminalIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
        )}
        <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>
          {formatComposerSlashCommandLabel(props.command)}
        </span>
      </span>
    </span>
  );
}

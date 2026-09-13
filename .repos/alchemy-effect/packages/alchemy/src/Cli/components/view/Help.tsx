/** @jsxImportSource react */
/** Branded help screens + the CliOutput formatter that renders them. */
import { stripVTControlCharacters } from "node:util";
import * as Option from "effect/Option";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import type { HelpDoc } from "effect/unstable/cli/HelpDoc";
import { Box, Heading, Text, useGlyphs } from "../ui/index.ts";
import type { JSX } from "react";
import packageJson from "../../../../package.json" with { type: "json" };
import type { CliKit } from "../../CliKit/CliKit.ts";
import {
  ANSI_BOLD,
  ANSI_DIM,
  ansiFg,
  glyphsFor,
  paint,
  truncate,
  theme,
} from "../../CliKit/index.ts";
import { Logo } from "./Logo.tsx";

const commandLabel = (command: {
  readonly name: string;
  readonly alias?: string | undefined;
}) => (command.alias ? `${command.name}, ${command.alias}` : command.name);

/** Shell-like highlighting shared by usage lines, examples, and help hints. */
function CommandText({ command }: { readonly command: string }): JSX.Element {
  const tokens = command.match(
    /\s+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g,
  ) ?? [command];
  let word = 0;
  let valueAfterFlag = false;

  return (
    <Text>
      {tokens.map((token, index) => {
        if (/^\s+$/.test(token)) return token;

        const currentWord = word++;
        const isFlag = token.startsWith("-");
        const isPlaceholder =
          (token.startsWith("<") && token.endsWith(">")) ||
          (token.startsWith("[") && token.endsWith("]"));
        const isQuoted =
          (token.startsWith('"') && token.endsWith('"')) ||
          (token.startsWith("'") && token.endsWith("'"));
        const isValue = valueAfterFlag || isQuoted;
        valueAfterFlag = isFlag;

        return (
          <Text
            key={`${index}:${token}`}
            bold={currentWord <= 1 || isFlag}
            color={
              currentWord === 0
                ? theme.color.accent
                : isFlag
                  ? theme.color.info
                  : isPlaceholder
                    ? theme.color.warning
                    : isValue
                      ? theme.color.success
                      : currentWord === 1
                        ? theme.color.accentBright
                        : undefined
            }
          >
            {token}
          </Text>
        );
      })}
    </Text>
  );
}

/** One aligned help row: fixed-width bold label cell + description. */
type RowProps = {
  label: JSX.Element | string;
  description: string;
  width: number;
};

function Row({ label, description, width }: RowProps) {
  return (
    <Box paddingLeft={2}>
      <Box width={width} flexShrink={0}>
        {typeof label === "string" ? (
          <Text bold tone="emphasis">
            {label}
          </Text>
        ) : (
          label
        )}
      </Box>
      <Text>{description}</Text>
    </Box>
  );
}

function BrandLine(): JSX.Element {
  const glyphs = useGlyphs();
  return (
    <Text>
      <Text tone="brand">{glyphs.selected}</Text>{" "}
      <Text bold tone="emphasis">
        alchemy
      </Text>{" "}
      <Text tone="muted">— Infrastructure as Effects</Text>
    </Text>
  );
}

/**
 * Branded help for every command. The root gets a brand header and shows
 * only `--help`/`--version` (as OPTIONS); subcommands list all global flags.
 */
type SubHelpProps = {
  doc: HelpDoc;
  root?: boolean;
};

function SubHelp({ doc, root = false }: SubHelpProps): JSX.Element {
  const commands = doc.subcommands?.flatMap((group) => group.commands) ?? [];
  const flags = doc.flags ?? [];
  const globalFlags = root
    ? (doc.globalFlags ?? []).filter(
        (flag) => flag.name === "help" || flag.name === "version",
      )
    : (doc.globalFlags ?? []);
  const args = doc.args ?? [];

  const flagLabel = (flag: (typeof flags)[number]) => {
    const aliases =
      flag.aliases.length > 0 ? `, ${flag.aliases.join(", ")}` : "";
    return `--${flag.name}${aliases}`;
  };
  const argLabel = (arg: (typeof args)[number]) =>
    arg.required ? `<${arg.name}>` : `[${arg.name}]`;
  // width from labels only — enum types (--log-level's choice list) would
  // otherwise blow the column out; long types truncate inside the cell
  const nameWidth =
    Math.min(
      30,
      Math.max(
        12,
        ...commands.map((c) => commandLabel(c).length),
        ...[...flags, ...globalFlags].map((f) => flagLabel(f).length),
        ...args.map((a) => argLabel(a).length),
      ),
    ) + 4;

  type FlagRowProps = { readonly flag: (typeof flags)[number] };

  function FlagRow({ flag }: FlagRowProps) {
    const label = flagLabel(flag);
    const typeRoom = nameWidth - label.length - 2;
    return (
      <Row
        width={nameWidth}
        description={Option.getOrElse(flag.description, () => "")}
        label={
          <Text>
            <Text bold color={theme.color.info}>
              --{flag.name}
            </Text>
            {flag.aliases.map((alias) => (
              <Text key={alias} color={theme.color.info}>
                , {alias}
              </Text>
            ))}
            {flag.type === "boolean" || typeRoom < 8 ? null : (
              <Text color={theme.color.warning}>
                {" "}
                {truncate(flag.type, typeRoom)}
              </Text>
            )}
          </Text>
        }
      />
    );
  }

  return (
    <Box flexDirection="column" flexShrink={root ? 0 : 1}>
      {root ? <BrandLine /> : null}
      {doc.description === "" ? null : (
        <Box marginTop={root ? 1 : 0}>
          <Text>{doc.description}</Text>
        </Box>
      )}
      <Box marginTop={doc.description === "" && !root ? 0 : 1}>
        <Heading glyph={false}>USAGE</Heading>
      </Box>
      <Text>
        {"  "}
        <Text tone="brand">$</Text> <CommandText command={doc.usage} />
      </Text>
      {args.length === 0 ? null : (
        <>
          <Box marginTop={1}>
            <Heading glyph={false}>ARGUMENTS</Heading>
          </Box>
          {args.map((arg) => (
            <Row
              key={arg.name}
              width={nameWidth}
              label={
                <Text bold color={theme.color.warning}>
                  {argLabel(arg)}
                </Text>
              }
              description={Option.getOrElse(arg.description, () => "")}
            />
          ))}
        </>
      )}
      {commands.length === 0 ? null : (
        <>
          <Box marginTop={1}>
            <Heading glyph={false}>COMMANDS</Heading>
          </Box>
          {commands.map((command) => (
            <Row
              key={command.name}
              width={nameWidth}
              label={
                <Text>
                  <Text bold color={theme.color.accentBright}>
                    {command.name}
                  </Text>
                  {command.alias === undefined ? null : (
                    <Text color={theme.color.info}>, {command.alias}</Text>
                  )}
                </Text>
              }
              description={command.description || ""}
            />
          ))}
        </>
      )}
      {flags.length === 0 ? null : (
        <>
          <Box marginTop={1}>
            <Heading glyph={false}>FLAGS</Heading>
          </Box>
          {flags.map((flag) => (
            <FlagRow key={flag.name} flag={flag} />
          ))}
        </>
      )}
      {globalFlags.length === 0 ? null : (
        <>
          <Box marginTop={1}>
            <Heading glyph={false}>{root ? "OPTIONS" : "GLOBAL FLAGS"}</Heading>
          </Box>
          {globalFlags.map((flag) => (
            <FlagRow key={flag.name} flag={flag} />
          ))}
        </>
      )}
      {doc.examples === undefined || doc.examples.length === 0 ? null : (
        <>
          <Box marginTop={1}>
            <Heading glyph={false}>EXAMPLES</Heading>
          </Box>
          {doc.examples.map((example) => (
            <Text key={example.command}>
              {"  "}
              <Text tone="brand">$</Text>{" "}
              <CommandText command={example.command} />
            </Text>
          ))}
        </>
      )}
      {commands.length === 0 ? null : (
        <Box marginTop={1}>
          <Text>
            <Text color={theme.color.muted}>Run '</Text>
            <CommandText
              command={`${doc.usage.replace(/\s*<subcommand>.*$/, "")} <command> --help`}
            />
            <Text color={theme.color.muted}>
              ' for more information on a command.
            </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

const formatSubHelp = (cli: CliKit["Service"], doc: HelpDoc) => {
  const termCols = cli.terminal.columns;
  return cli.output.format(
    <Box width={termCols}>
      <SubHelp doc={doc} />
    </Box>,
    { columns: termCols },
  );
};

/** Hide the logo entirely when it can't be at least this many columns wide. */
const MIN_LOGO_COLS = 20;

const formatRootHelp = (cli: CliKit["Service"], doc: HelpDoc) => {
  const termCols = cli.terminal.columns;

  // First pass: render the text alone to measure its exact footprint (post
  // ANSI codes and wrapping), then size the logo into the leftover space.
  const text = cli.output.format(
    <Box width={termCols}>
      <SubHelp doc={doc} root />
    </Box>,
    { columns: termCols },
  );

  // The braille logo is mojibake without Unicode support.
  if (!cli.terminal.unicode) return text;

  const lines = text.split("\n");
  const textWidth = Math.max(
    ...lines.map((line) => stripVTControlCharacters(line).trimEnd().length),
  );
  const textHeight = lines.length;

  // Fill the free space beside the text: a logo of C columns is C/2 rows
  // tall (braille cell is 1:2). Reserve two rows for the wordmark caption.
  const logoCols = Math.min(termCols - textWidth - 2, (textHeight - 2) * 2);

  if (logoCols < MIN_LOGO_COLS) return text;

  return cli.output.format(
    <Box flexDirection="row" width={termCols}>
      <SubHelp doc={doc} root />
      <Box
        flexGrow={1}
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
      >
        <Logo cols={logoCols} />
        <Box marginTop={1}>
          <Text>
            <Text bold color={theme.color.accent}>
              ALCHEMY
            </Text>{" "}
            <Text tone="muted">v{packageJson.version}</Text>
          </Text>
        </Box>
      </Box>
    </Box>,
    { columns: termCols },
  );
};

export const brandedCliFormatter = (
  cli: CliKit["Service"],
): CliOutput.Formatter => {
  const fallback = CliOutput.defaultFormatter();
  const glyphs = glyphsFor(cli.terminal.unicode);
  const formatErrorLine = (message: string) =>
    `${paint(ansiFg(theme.color.danger), `${glyphs.error} error:`)} ${message}`;
  return {
    ...fallback,
    formatHelpDoc: (doc) =>
      doc.usage.startsWith("alchemy <subcommand>")
        ? formatRootHelp(cli, doc)
        : formatSubHelp(cli, doc),
    formatVersion: (name, version) =>
      `${paint(ansiFg(theme.color.brand), glyphs.selected)} ${paint(ANSI_BOLD, name)} ${paint(ANSI_DIM, `v${version}`)}`,
    formatError: (error) => `\n${formatErrorLine(error.message)}`,
    formatErrors: (errors) => {
      if (errors.length === 0) return "";
      if (errors.length === 1) return `\n${formatErrorLine(errors[0].message)}`;
      return `\n${formatErrorLine(`${errors.length} problems`)}\n${errors
        .map((error) => `  ${paint(ANSI_DIM, glyphs.bullet)} ${error.message}`)
        .join("\n")}`;
    },
  };
};

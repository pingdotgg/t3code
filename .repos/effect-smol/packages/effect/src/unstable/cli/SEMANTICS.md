# CLI Semantics (Effect CLI)

This file records the intended parsing semantics with a short usage example and the test that locks it in. Examples show shell usage, not code.

- **Shared parent flags allowed before or after subcommand (npm-style)**\
  Example: `tool --global install --pkg cowsay` and `tool install --pkg cowsay --global` (when `--global` is declared with `Command.withSharedFlags(...)`)\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should accept shared parent flags before or after a subcommand (npm-style)"

- **Local parent flags are not inherited by subcommands**\
  Example: `tool --workspace docs chat --topic bugs` fails when `--workspace` is local to `tool`\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should reject parent local flags on subcommand paths"

- **Only the first value token may open a subcommand; later values are operands**\
  Example: `tool install pkg1 pkg2` → `install` chosen as subcommand; `pkg1 pkg2` are operands\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should accept shared parent flags before or after a subcommand (npm-style)" (second invocation covers later operands)

- **`--` stops option parsing; everything after is an operand (no subcommands/flags)**\
  Example: `tool -- child --value x` → operands: `child --value x`; subcommand `child` is not entered\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should treat tokens after -- as operands (no subcommand or flags)"

- **Options may appear before, after, or between operands (relaxed POSIX Guideline 9)**\
  Examples: `tool copy --recursive src dest`, `tool copy src dest --recursive`, `tool copy --recursive src dest --force`\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should support options before, after, or between operands (relaxed POSIX Syntax Guideline No. 9)"

- **Boolean flags default to true when present; explicit true/false literals are accepted immediately after**\
  Example: `tool --verbose deploy --target-version 1.0.0`\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should handle boolean flags before subcommands"

- **Boolean flags support canonical `--no-<flag>` negation, and optional booleans distinguish omission from explicit false**\
  Example: `tool --no-verbose` → `false`; `--no-verbose=false` is rejected; `Flag.optional(Flag.boolean("verbose"))` yields `Option.none()` when omitted\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should support optional boolean flags and --no-<flag> negation"

- **Unknown subcommands emit suggestions**\
  Example: `tool cpy` → suggests `copy`\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should suggest similar subcommands for unknown subcommands"

- **Unknown options emit suggestions (long and short)**\
  Examples: `tool --debugs copy ...`, `tool -u copy ...`\
  Tests: `packages/effect/test/unstable/cli/Command.test.ts` – "should suggest similar options for unrecognized options" and "should suggest similar short options for unrecognized short options"

- **Repeated key=value flags merge into one map**\
  Example: `tool env --env foo=bar --env cool=dude` → `{ foo: "bar", cool: "dude" }`\
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should merge repeated key=value flags into a single record"

- **Shared parent context is accessible inside subcommands**
  Example: `tool --global install --pkg cowsay` → subcommand can read `global` from parent context when `global` is shared
  Test: `packages/effect/test/unstable/cli/Command.test.ts` – "should allow direct accessing parent config in subcommands"

- **Built-in flags (`--version`, `--help`) take global precedence**
  Example: `tool --version copy src dest` → prints version and exits; subcommand is not run
  Tests: `packages/effect/test/unstable/cli/Command.test.ts` – "should print version and exit even with subcommands (global precedence)" and "should print version and exit when --version appears before subcommand"

If you add or change semantics, update this file and reference the exact test that proves the behavior.

## Semantics Landscape (popular CLIs vs Effect)

Below each semantic you’ll find: a short description, a usage example, how major CLI libraries handle it (and whether it’s configurable), and where Effect currently lands (with suggestions if any).

### Parent flags after a subcommand name (npm-style globals)

- **What**: Whether options defined on the parent command can appear _after_ the subcommand token.
- **Example**: `tool install --pkg cowsay --global`
- **Commander / yargs / clap**: Allowed by default; commander/clap can tighten with options.
- **Click / argparse / docopt**: Not allowed; options must be before the command they belong to.
- **Cobra**: Persistent flags are available to children; placement is typically before subcommand, but not strictly enforced.
- **Effect (current)**: Allowed for parent flags explicitly declared as shared via `Command.withSharedFlags(...)`. Backed by test: “should accept shared parent flags before or after a subcommand (npm-style)”.
- **Suggestion**: Keep permissive placement for shared flags, with local-by-default declaration semantics.

### Options after operands (relaxed POSIX Guideline 9)

- **What**: Whether flags can appear after or between positional arguments.
- **Example**: `tool copy src dest --recursive` or `tool copy --recursive src dest --force`
- **Commander / yargs / clap**: Allowed by default; clap can be configured to prefer subcommand precedence.
- **Click / argparse / docopt**: Disallow; options must precede positionals for that command.
- **Cobra**: Generally allows mixed order; `--` ends options.
- **Effect (current)**: Allowed. Test: “should support options before, after, or between operands (relaxed POSIX Syntax Guideline No. 9)”.
- **Suggestion**: Keep permissive; no change.

### Subcommand selection: only the first value may open a subcommand

- **What**: Whether only the first non-option token can be treated as a subcommand name.
- **Example**: `tool install pkg1 pkg2` → `install` is subcommand; `pkg1 pkg2` are operands.
- **Commander / yargs / clap / Click / argparse / docopt / Cobra**: Yes, subcommand chosen at first value (unless special external-subcommand features are enabled).
- **Effect (current)**: Yes. Covered implicitly by subcommand tests.
- **Suggestion**: Keep; this is the least surprising and matches most ecosystems.

### End-of-options marker `--`

- **What**: Tokens after `--` are treated purely as operands.
- **Example**: `tool -- child --value x` → operands `child --value x`.
- **Commander / yargs / clap / Click / argparse / docopt / Cobra**: Supported.
- **Effect (current)**: Supported. Test: “should treat tokens after -- as operands (no subcommand or flags)”.
- **Suggestion**: Keep; already locked in by test.

### Boolean flags defaulting to true when present; optional explicit literal

- **What**: Supplying `--flag` implies true; explicit `--flag false` (or 0/no/off) is accepted.
- **Example**: `tool --verbose deploy` and `tool --verbose false deploy`.
- **Commander / yargs / clap**: Yes; boolean options coerce common literals.
- **Click / argparse / docopt**: Typically `--flag/--no-flag` pairs; some accept explicit literals with `type=bool` in argparse.
- **Effect (current)**: Yes. Test: “should handle boolean flags before subcommands”.
- **Suggestion**: Keep; no change.

### Canonical `--no-<flag>` boolean negation

- **What**: Boolean flags accept a canonical negated long form in addition to explicit literals.
- **Example**: `tool --no-verbose`.
- **Value form**: Negated form does not accept an explicit value; use `--verbose false` or bare `--no-verbose`.
- **Commander / yargs / clap / Click**: Commonly supported for long boolean options.
- **Effect (current)**: Supported for canonical long flag names. Test: “should support optional boolean flags and --no-<flag> negation”.
- **Suggestion**: Keep; this matches the existing docs and generated completions.

### Unknown subcommands/options suggestions

- **What**: Whether unrecognized tokens produce Levenshtein suggestions.
- **Example**: `tool cpy` → suggest `copy`; `tool --debugs` → suggest `--debug`.
- **Commander / yargs / clap**: Suggestions configurable (clap has built-in `color`/`suggestions`); commander can display “Did you mean”.
- **Click / argparse / docopt / Cobra**: Usually fail with an error; some wrappers add suggestions.
- **Effect (current)**: Suggestions enabled; tests cover unknown subcommands and options (short/long).
- **Suggestion**: Keep; already aligned with “friendly” CLIs.

### Parent context accessible in subcommands

- **What**: Ability for subcommand handlers to read parent flags intentionally shared by the parent command.
- **Example**: `tool --global install --pkg cowsay` → subcommand reads `global` when `global` is shared.
- **Commander / yargs / clap / Cobra**: Supported via shared options or persistent flags; Click/argparse require manual plumbing.
- **Effect (current)**: Supported for shared flags only; test “should allow direct accessing parent config in subcommands”.
- **Suggestion**: Keep; explicit sharing avoids accidental inheritance.

### Repeated key=value flags merging

- **What**: Multiple `--env KEY=VAL` occurrences merge into a single map.
- **Example**: `tool --env foo=bar --env cool=dude` → `{foo: "bar", cool: "dude"}`.
- **Commander / yargs / clap**: Arrays/maps supported via custom options; behavior differs unless configured.
- **Effect (current)**: Merge; test “should merge repeated key=value flags into a single record”.
- **Suggestion**: Keep; predictable and convenient.

### Required or mutually exclusive flag sets (validation, not parsing)

- **What**: Constraints like "must provide either --token or --user/--pass", or "--json and --color cannot both be set".
- **Commander / yargs / clap**: Provide APIs for required/conflicts; Click supports required options and `mutually_exclusive` via groups; argparse has mutually exclusive groups.
- **Effect (current)**: Not enforced at parser level. Would live in a validation layer if needed.
- **Suggestion**: Stay out of parsing; add optional validators in configuration if/when a product needs it.

### Built-in flags (`--version`, `--help`) global precedence

- **What**: Whether `--version` and `--help` take precedence over subcommands and other arguments.
- **Example**: `tool --version install pkg` or `tool install --version pkg`
- **git / cargo (clap) / npm**: `--version` anywhere prints version and exits. Subcommand is ignored.
- **gh (Cobra)**: `--version` only works alone on root command. `gh --version pr` errors.
- **docker / bun**: Subcommand runs; `--version` on root is ignored if subcommand follows.
- **Effect (current)**: Global precedence (git/npm style). `--version` prints version and exits regardless of subcommands or position.
- **Suggestion**: Keep; this is the most user-friendly behavior. Users expect `--version` to work anywhere.

## Opinionated default

Effect should remain on the permissive, npm/commander-style side: flexible option placement, shared parent flags usable before or after subcommands, strict `--` handling, and single-shot subcommand selection on the first value. This keeps UX friendly for modern CLIs while remaining predictable via documented rules and tests.

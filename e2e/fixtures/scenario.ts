// @effect-diagnostics nodeBuiltinImport:off - stdlib-only fake CLI helpers, outside any Effect runtime.
/**
 * What every fake provider CLI does with a prompt, so a test drives each provider the
 * same way:
 * - `write <file>` runs a shell command that writes the file in the workspace, asking
 *   for approval first when the turn's runtime mode requires it.
 * - `wait` says `WAITING_TEXT`, so a test knows the provider started the turn, then keeps
 *   it running until it is interrupted.
 * - anything else gets the reply `Fake <Provider> received: <prompt>`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type Scenario =
  | { readonly kind: "reply" }
  | { readonly kind: "wait" }
  | { readonly kind: "write"; readonly fileName: string };

/** Reads what a fake should do from the turn's prompt text. */
export function scenarioFor(prompt: string): Scenario {
  if (/\bwait\b/i.test(prompt)) return { kind: "wait" };
  const fileName = /\bwrite\s+([\w.-]+)/i.exec(prompt)?.[1];
  return fileName === undefined ? { kind: "reply" } : { kind: "write", fileName };
}

/** The reply a fake gives to an ordinary prompt. */
export const replyText = (provider: string, prompt: string) =>
  `Fake ${provider} received: ${prompt}`;

export const WAITING_TEXT = "Waiting until stopped.";

export const WRITTEN_CONTENT = "Written by fake provider\n";

/** The shell command a fake reports for `write <file>`. */
export const writeCommand = (fileName: string) =>
  `printf 'Written by fake provider\\n' > ${fileName}`;

/** Performs `write <file>` in `cwd`, the effect of the approved command. */
export function writeScenarioFile(cwd: string, fileName: string) {
  NodeFS.writeFileSync(NodePath.join(cwd, fileName), WRITTEN_CONTENT);
}

export interface JsonSchema {
  readonly type?: string;
  readonly enum?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
}

/**
 * Answers a text-generation request (thread titles, commit messages): text fields echo
 * the first line of the prompt's user message, so a thread is titled by its first message.
 */
export function textGenerationOutput(schema: JsonSchema, prompt: string): unknown {
  const text = /User message:\n(.+)/.exec(prompt)?.[1]?.trim() ?? "Fake provider title";
  const fill = (node: JsonSchema): unknown => {
    switch (node.type) {
      case "object":
        return Object.fromEntries(
          Object.entries(node.properties ?? {}).map(([key, value]) => [key, fill(value)]),
        );
      case "array":
        return [];
      case "boolean":
        return false;
      case "number":
      case "integer":
        return 0;
      default:
        return node.enum?.[0] ?? text;
    }
  };
  return fill(schema);
}

/** The value after `--name` or `--name=value` in `args`, if present. */
export function flagValue(args: ReadonlyArray<string>, name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

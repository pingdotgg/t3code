import * as Schema from "effect/Schema";
import { agentShellCommands } from "../../apps/server/src/sourceControl/agentShellCommands.ts";

export const NATIVE_COMPUTER_USE_SKILL_PATH =
  "/Applications/Acme.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/skills/computer-use/SKILL.md";
export const NATIVE_COMPUTER_USE_TOOL = "mcp__node_repl__js";

export const SYNTHETIC_COMPUTER_USE_SKILL = `---
name: computer-use
description: Control Mac apps using the native sky service.
---
Read this entire file before using sky. For Mac UI, use the persistent node_repl js tool.
Import the configured service with const sky = (await import('@oai/sky')).sky.
Read fresh app state with await sky.get_app_state({app: 'com.apple.calculator'}).
Use sky.click({app, x, y}), sky.type_text({app, text}) and sky.press_key({app, key}) for input.
Use await sky.get_app_state({app}) again to inspect the result and obtain its screenshot.
Ask the user to confirm destructive actions before performing them. Do not install tools or change configuration.
End of the complete synthetic computer-use skill.
`;

export const NativeComputerUseExpect = Schema.Literals(["use", "avoid"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isFullNativeSkillRead(tool: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (tool === "Read")
    return (
      input.file_path === NATIVE_COMPUTER_USE_SKILL_PATH &&
      input.limit === undefined &&
      input.offset === undefined
    );
  if (tool !== "Bash" || typeof input.command !== "string") return false;
  const commands = agentShellCommands(input.command);
  return (
    commands.length === 1 &&
    commands[0]?.executable === "cat" &&
    commands[0].words.length === 2 &&
    commands[0].words[1] === NATIVE_COMPUTER_USE_SKILL_PATH
  );
}

export function gradeNativeComputerUse(
  expectation: typeof NativeComputerUseExpect.Type | undefined,
  calls: ReadonlyArray<{
    readonly step: number;
    readonly tool: string;
    readonly input: unknown;
    readonly failed?: boolean;
    readonly output?: string;
  }>,
) {
  if (expectation === undefined) return [];
  const native = calls.findIndex((call) => call.tool === NATIVE_COMPUTER_USE_TOOL);
  const read = calls.findIndex(
    (call) =>
      !call.failed &&
      isFullNativeSkillRead(call.tool, call.input) &&
      call.output === SYNTHETIC_COMPUTER_USE_SKILL,
  );
  return [
    {
      check: `nativeComputerUse ${expectation}`,
      pass:
        expectation === "avoid"
          ? native < 0 &&
            !calls.some(
              (call) =>
                ["Bash", "Read"].includes(call.tool) &&
                (JSON.stringify(call.input) ?? "").includes(NATIVE_COMPUTER_USE_SKILL_PATH),
            )
          : read >= 0 &&
            native > read &&
            calls[read]!.step < calls[native]!.step &&
            calls
              .slice(native)
              .some(
                (call) =>
                  call.tool === NATIVE_COMPUTER_USE_TOOL &&
                  !call.failed &&
                  /sky/.test(JSON.stringify(call.input)),
              ),
    },
  ];
}

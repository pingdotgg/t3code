import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type {
  SkillSettingsChange,
  SkillSettingsWriter,
} from "@t3tools/provider-core/server/driver";

/**
 * Stands in for the `codex app-server` process and nothing else: it edits the real `config.toml`
 * the way Codex does (checked against codex 0.160.1): a path is recorded by the real path of its
 * SKILL.md, `enabled: true` removes the entry for the selector, and the answer is the selector's
 * state.
 */
export const makeCodexDouble = (codexHome: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(codexHome, "config.toml");
    const canonical = (value: string) => fs.realPath(value).pipe(Effect.orElseSucceed(() => value));
    const calls: SkillSettingsChange[] = [];
    const state = { opened: 0, effective: undefined as boolean | undefined };
    const write: SkillSettingsWriter = (change) =>
      Effect.gen(function* () {
        calls.push(change);
        const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
        const document = parseToml(text) as { skills?: { config?: Record<string, unknown>[] } };
        const rules = document.skills?.config ?? [];
        const selected = "path" in change ? yield* canonical(change.path) : change.name;
        const kept: Record<string, unknown>[] = [];
        for (const rule of rules) {
          const named =
            "path" in change && typeof rule.path === "string"
              ? (yield* canonical(rule.path)) === selected
              : "name" in change && rule.name === selected;
          if (!named) kept.push(rule);
        }
        if (!change.enabled) {
          kept.push(
            "path" in change
              ? { path: selected, enabled: false }
              : { name: selected, enabled: false },
          );
        }
        const next = kept.length > 0 ? { skills: { config: kept } } : {};
        yield* fs.makeDirectory(codexHome, { recursive: true });
        yield* fs.writeFileString(file, kept.length > 0 ? stringifyToml(next) : "");
        return { effectiveEnabled: state.effective ?? change.enabled };
      }).pipe(Effect.orDie);
    return { file, calls, state, write };
  });

export type CodexDouble = Effect.Success<ReturnType<typeof makeCodexDouble>>;

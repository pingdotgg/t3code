---
"effect": patch
---

Rename CLI constructors to PascalCase, aligning scalar names with `Schema` and `Config`. This is a breaking change; parsing behavior is unchanged.

In `Primitive`, `Param`, `Flag`, and `Argument`, capitalize existing constructor names, with these exceptions:

| Previous  | New        | Modules               |
| --------- | ---------- | --------------------- |
| `integer` | `Int`      | All four              |
| `float`   | `Finite`   | All four              |
| `none`    | `Never`    | All four              |
| `choice`  | `Literals` | Param, Flag, Argument |

`Primitive.choice` becomes `Primitive.Choice`; `choiceWithValue` becomes `ChoiceWithValue` where available.

In `Prompt`, capitalize control constructors except `text` → `String`, `integer` → `Int`, and `float` → `Number`. Rename public types `IntegerOptions` → `IntOptions` and `FloatOptions` → `NumberOptions`. Shared `TextOptions` is unchanged. `Prompt.Number` retains its existing parser, without a finite-number restriction.

In `GlobalFlag`, rename `action` → `Action` and `setting` → `Setting`. Factories and combinators, including `Command.make` and `Prompt.succeed`, keep their names.

Update public `_tag` matches and completion descriptors:

- `Primitive`: `"Integer"` → `"Int"`, `"Float"` → `"Finite"`, `"None"` → `"Never"`.
- `Completions.FlagType` and `Completions.ArgumentType`: `"Integer"` → `"Int"`, `"Float"` → `"Finite"`.

Sentinels still always fail; their internal parameter name is now `"__never__"`. Help labels and completion scripts are unchanged.

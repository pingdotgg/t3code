---
"@effect/ai-anthropic": patch
---

Fix `Memory_20250818` provider-defined tool missing `requiresHandler: true`. Like the other client-executed tools (`TextEditor_20250728`, `Bash_2025*`, `ComputerUse_2025*`), the memory tool requires the application to implement its execution (view/create/str_replace/insert/delete/rename over `/memories/*`). Without this flag, `Tool.HandlersFor` excluded it from the required handlers, making it impossible to type-check a handler for `Memory_20250818` in `Toolkit.toLayer`.

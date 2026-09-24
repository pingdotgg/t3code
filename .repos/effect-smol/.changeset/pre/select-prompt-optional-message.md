---
"effect": patch
---

Make `message` optional for `Prompt.Select` and `Prompt.MultiSelect`. When omitted, prompts display only the choices and submission shows a tick followed by the selected titles. `Prompt.AutoComplete` still requires a message.

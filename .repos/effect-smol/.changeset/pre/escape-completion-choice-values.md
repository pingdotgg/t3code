---
"effect": patch
---

Fix shell completion for choice values containing quotes, spaces, word-break characters, Unicode, and shell metacharacters.

Bash now quotes candidates for readline, keeps choice values intact when reconstructing words, and supports Bash 3.2 without associative arrays. Fish and Zsh escape choices across both parsing rounds, and Fish hides value-taking flags after use without suppressing their value completions.

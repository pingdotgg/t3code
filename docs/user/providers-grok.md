# Grok Build

T3 Code discovers Grok models and their available reasoning-effort choices from
the Grok Build CLI. Models that report reasoning support get a Reasoning menu.
Grok 4.5 offers Low, Medium, and High, with High as the default. T3 Code keeps
that known Grok 4.5 menu available when older CLI metadata omits it.

Reasoning effort is fixed when a Grok conversation starts. To use a different
effort or model after sending the first message, start a new chat and choose the
new value before sending.

Install and authenticate the CLI as described in [Install](./install.md). The
Grok process runs on the machine hosting the T3 Code server, including when you
control it from another browser or the mobile app.

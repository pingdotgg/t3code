# conn-app

Native macOS GPUI desktop application binary for Conn.

- **Target look:** Pixel-for-pixel Conn desktop (`docs/design-spec.md`, `.claude/skills/nckrtl-shell-design/SKILL.md`).
- **References:** `.refs/threadbear/desktop/gpui/src/` (window chrome, `gpui-kit = "=0.9.0"`, `alacritty_terminal`, `automation.rs`, macOS AppKit shims) and `apps/web/src/components/`.
- **Safety:** Always connect tests to a disposable `conn-server --state-dir`; never touch live `~/.t3/userdata`.

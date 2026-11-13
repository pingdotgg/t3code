# Vendored files

| Path | Source | Commit | Licence |
| --- | --- | --- | --- |
| `.claude/skills/rust-best-practices`, `rust-review`, `rust-port` | https://github.com/morganlinton/BeautifulRust `skills/` | `b9718436d77ee7bcf17cdcb6aa27628feb95d97a` (2026-11-08) | MIT, `.claude/skills/BEAUTIFULRUST-LICENSE` |
| `lints/beautiful-rust/` | the same repository, `lints/` | the same | MIT |

The files are unchanged copies. The skills' `evals/` folders, the benchmark harness and the
hosted MCP server (`mcp.beautifulrust.dev`) are left out: agents here need no outside service.

`.agents/skills` is a link to `.claude/skills`, for agents that read the Agent Skills layout.

To update: copy the same paths from a newer commit and change the commit above.

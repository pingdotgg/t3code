# Hermes H0 conformance evidence

- Date:
- Operator:
- Official Hermes source path:
- Verified source revision: `2c1a38a3cc4b5727c817f007a46c377cafddde4c`
- Harness command:
- Sanitized JSONL:
- Raw capture location outside repository:
- Live/destructive opt-ins used:

| Area                               | Status | Sanitized evidence sequence(s) | Notes / blocker                                  |
| ---------------------------------- | ------ | ------------------------------ | ------------------------------------------------ |
| Revision and handshake             |        |                                | `gateway.ready` has no version/capabilities      |
| Sessions and durable identity      |        |                                | Distinguish stored session key from live sid     |
| Prompt and ordered events          |        |                                | Synthetic streaming is not transcript durability |
| Tools                              |        |                                | Live reviewed scenario required                  |
| Approval and clarification         |        |                                | Approval response lacks request ID               |
| Commands and models                |        |                                |                                                  |
| Image, file, and PDF attachments   |        |                                | Preserve sanitized identity/metadata only        |
| Latest-only branch and title       |        |                                | No exact message/run boundary                    |
| Cron inventory and mutation        |        |                                | No durable global event cursor                   |
| Disconnect and reconnect           |        |                                | Read reconciliation only                         |
| Unknown-method connection survival |        |                                | Follow with a known read on the same socket      |
| Unknown server-event preservation  |        |                                | No safe pinned-runtime injection seam            |
| Ambiguous mutation                 |        |                                | Must remain indeterminate; never replay          |
| Session MCP and writer fencing     |        |                                | No supported capability                          |

## Acceptance statement

Do not mark H0 accepted while a security-critical row is failed, blocked, or indeterminate.
Document upstream work needed for each remaining blocker.

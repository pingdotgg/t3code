# Upstream patch ledger

Record selective upstream cherry-picks and durable local divergences here.

| Upstream change                                  | Product integration                       | Reason                                                                    | Local modification                                                                                                      |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| T3 production release, relay, and Expo workflows | Archived under `docs/upstream/workflows/` | Prevent the fork from publishing to or waiting on upstream-owned services | Restore only after the named owner provides least-privilege credentials, a reviewed release path, and a tested rollback |
| Blacksmith runner labels                         | Standard GitHub-hosted runner labels      | Let CI and manually triggered mobile workflows run in the public fork     | Recheck runner capacity and timeouts after each upstream sync                                                           |

A normal full-baseline merge does not need one row per upstream commit. Record only changes that would otherwise be difficult to understand during a later upstream synchronization.

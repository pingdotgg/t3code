# Trail patches in upstream (T3 Code) files

Trail keeps upstream mergeable by limiting edits to T3-owned files and marking each seam with `TRAIL-PATCH` in the source. New Trail UI lives under `apps/web/src/trail/` and new routes under `apps/web/src/routes/`.

When you add or change a seam, update this table in the same PR.

| File                                                                                                       | What                                                                                                          | Issue / note                                           |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`apps/web/src/components/AppSidebarLayout.tsx`](apps/web/src/components/AppSidebarLayout.tsx)             | Wrap main content in `TrailShell` (pass-through until [#2](https://github.com/Joeydekruis/trail-v2/issues/2)) | Phase 0 stub                                           |
| [`apps/web/src/components/sidebar/SidebarChrome.tsx`](apps/web/src/components/sidebar/SidebarChrome.tsx)   | Interim **Board** utility nav next to Issues                                                                  | [#1](https://github.com/Joeydekruis/trail-v2/issues/1) |
| [`apps/web/src/components/sidebar/mainAppLocation.ts`](apps/web/src/components/sidebar/mainAppLocation.ts) | Treat `/board` as a sidebar utility page                                                                      | [#1](https://github.com/Joeydekruis/trail-v2/issues/1) |

## Related issues

1. [Read-only Kanban board](https://github.com/Joeydekruis/trail-v2/issues/1)
2. [TrailShell, project rail, primary nav](https://github.com/Joeydekruis/trail-v2/issues/2)
3. [`/files` view for repo `docs/`](https://github.com/Joeydekruis/trail-v2/issues/3)

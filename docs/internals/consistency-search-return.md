# Search return context

Proposed cross-surface constraint: Back from a nested search picker restores the
parent query and navigation context. Each nested scope owns its input. Clearing a
child query must not silently clear its parent. This proposal is informed by
Apple’s [Searching](https://developer.apple.com/design/human-interface-guidelines/searching)
and [Navigation and search](https://developer.apple.com/design/human-interface-guidelines/navigation-and-search)
guidance; it is not a claim of Apple certification or prior maintainer approval.

For example, filter commands with `>new thread`, enter **New thread in…**, and
filter the project picker. Back should restore `>new thread`, not an unfiltered
command list. Further nested pickers restore one level at a time. Visible Back
and Backspace on an empty child input have the same meaning. Removing a picker’s
initial path prefix remains an existing way to leave that picker; it also
restores the parent input.

Return must leave a predictable keyboard target. Preserve the prior highlighted
item where the component’s public API supports it; otherwise select the first
enabled matching result. The web palette uses this fallback because its Base UI
Autocomplete has no public API to restore a highlighted item. Do not reorder
results or simulate keyboard events to recreate a highlight. Verify that Enter
executes the visible highlighted result after returning.

Closing and reopening is a fresh invocation. Direct requests to search linked
threads, add a project, choose a project for a new thread, or change theme also
start fresh and must not retain unrelated parent queries. Explicitly clearing
input at the root is a reset, not Back. Network result completeness is a separate
constraint.

Web and Electron share the nested command picker. React Native’s palette closes
before presenting its destination sheet, so it has no in-palette return path;
reopening starts fresh there. Opening file or content search from a palette action creates a bounded parent
context: Escape returns to that command query. Launching a mode directly by its
shortcut starts fresh. Selecting a file or otherwise closing the overlay discards
that return context and must not reopen the palette. Child input never replaces
the parent query.

Acceptance covers distinct parent and child queries, multiple levels of Back,
path-prefix removal, an explicitly cleared root, fresh open, and direct-open
replacement while already in a picker. Runtime verification must check both Back
entry points, input focus, and the highlighted-result/Enter fallback with a
nonempty result list. State-transition tests alone do not prove that keyboard
behavior.

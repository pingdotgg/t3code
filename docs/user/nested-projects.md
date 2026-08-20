# Projects inside other projects

A project is a folder, not a repository. You can add `~/delta` and `~/delta/commerce-pricing` as two projects of the same repository: each keeps its own threads, title, scripts, icon, and `t3.json`, and agents you start in the nested project run with that subdirectory as their working directory. Git operations still use the real repository, so status, commits, and pull requests behave the same in both.

Both projects appear as their own row in the sidebar, in the command palette (**New thread in…** and **Open project**), in Settings under **Projects**, and on the mobile home screen. Two clones of the same repository at unrelated paths still share one row — that is what project grouping is for.

## Telling two rows apart

Rows are named after the repository by default, so a nested project reads as the same repository as its parent. When two rows would carry the same name, T3 Code appends the path inside the repository: `kosyanmedia/delta · commerce-pricing`, with `.` for the repository root.

Searching finds a project by anything it is called: its title, its repository name, its full path, and each folder in that path. Typing `commerce-pricing` finds the nested project even when the row reads `kosyanmedia/delta`.

## Naming projects after their path

To name every project after its folder instead of its repository, turn on **Use paths as project names** in Settings under **General** (on mobile, Settings → **Project Grouping** → **Use paths as names**). Rows then read `commerce-pricing` and `delta`. Repository names remain searchable.

Turning the setting off restores repository names. It only changes labels — your projects, their threads, and their settings are untouched either way.

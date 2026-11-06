# Code navigation

Open a file from a thread's file browser and expand **Code relationships** below the preview to
see how it connects to the rest of the project. Results come from the thread's own checkout, its
worktree when it has one.

A project in a git repository starts indexing in the background when you add it, or the first time
you open or run a thread in it. A worktree has its own index, built and kept current while an agent
works in it, or the first time something asks it a code question, such as expanding this section or
an agent using the code graph. An idle worktree is not refreshed until an agent is active in it
again. A worktree's index is removed when its thread settles, unless other unsettled threads share
the worktree. It is also removed when Maintenance removes the worktree, and after 7 days with no
activity on the worktree's threads, unless one of them is pinned or marked active. The next agent
run rebuilds it. Until an index is ready, the section says the checkout is not indexed yet. Folders
outside a git repository index only on a code question.

Indexes are stored in T3 Code's data directory, not in your repository. Folders an earlier version
left in a project or worktree are removed automatically when T3 Code starts.

Turn automatic indexing off in **Settings → Labs → Automatic code indexing**. Then a checkout only
indexes when something asks it a code question.

- **Symbols** lists the file's declarations. Select one to see its callers, callees, references,
  impact (files that depend on it), and **Tests**: test files that reach it within a few calls.
- **Decisions** shows project knowledge whose entities name this file's path or one of its
  symbols. A symbol name is not unique, so a fact about another function with the same name in a
  different file shows up too; those rows say **matched by name**.
- **Prior work** lists threads whose turn checkpoints included this file. Choose one to open it.
  A checkpoint records every change in that thread's workspace, including changes by people or
  other threads sharing it, so a row means the file was present at a checkpoint, not that the
  thread wrote the change.

Relationships are found by reading source, not by compiling it. They can miss calls made through
values or dynamic dispatch and can mistake one same-named symbol for another. Each row is marked
**compiler indexed**, **static candidate**, or **heuristic**, and an empty list does not prove
that nothing calls the code or that it is untested.

The badge next to **Code relationships**, and **Code index** in a thread's details, shows whether
the index matches the checkout: **Ready**, **Partial** (source files are missing from the index),
**Stale** (files changed since indexing; **Stale @abc1234** when the checkout has moved past the
commit it was indexed at), **Indexing** (building the first index), **Not indexed**, or **Index
failed**. Files with no code to analyze, such as docs and images, don't count against **Ready**.
Code queries refresh a stale index in the background, and so do agent turns while automatic
indexing is on. Results keep coming from the previous index until the new one is ready. If a
refresh fails, the badge says so and the previous index keeps answering.

An index covers at most 10,000 files. A larger repository shows **Partial**, with your own source
indexed ahead of files in hidden folders.

On mobile, the file screen has a compact **Code relationships** section with symbols, callers,
and impact.

Agents can use the same reads through T3 Code's MCP tools, including the file's prior work.

## Explore calls around a symbol

Choose **Open in explorer** next to a symbol under **Symbols**, or search a project from the
command palette and pick **Explore** under **Code explorer**. The explorer puts the symbol in the
middle, its callers on the left and its callees on the right. Switch to **2 hops** to see callers
of callers and callees of callees; the explorer draws at most 60 symbols and says when it left
some out. Solid, dashed, and dotted lines mark compiler-indexed, static-candidate, and heuristic
calls, and the list below the graph shows the same symbols as text. Choose a symbol to center on
it, or its open button to jump to it in the file preview; a caller opens at its call site.

**Call path** answers whether the symbol reaches another one, or is reached by it, through calls
anywhere in the project. It searches up to 6 calls deep, so "no call path" means none was found
within that bound, not that none exists.

The explorer is available in the web and desktop apps.

## Review a pull request's impact

In a pull request's **Code** tab, expand **Potentially affected**, then expand a changed file to
see the callers and likely tests of the declarations its changes touch, up to 20 per file. This
needs a thread with the pull request's head branch checked out, such as one started with
**Work on PR**; without one, the panel says there is nothing to analyze. If that checkout is
behind the pull request's latest push, the panel says so.

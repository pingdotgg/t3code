# Tasks

A task is a Markdown file on the machine running T3 Code. Threads can share a task, and its document stays open beside them. The file stays where it is and remains the source of truth.

## Import a task

Choose **+** next to **Tasks** in the sidebar and enter the file's path on that machine. Importing does not change the file.

## Create a task

In a new thread, choose **Task > Create new task...**, then enter a title and an optional description. Nothing is written until you send the thread, so cancelling the draft leaves no file. Sending creates the file, keeping your description word for word, and starts the thread on it. The task folder defaults to a managed `tasks` folder in T3 Code's data directory; type another path to use your own. This client remembers the path per environment.

By default the thread's agent also enriches the task: it adds a goal and context to the file and keeps your description unchanged. If that fails, the thread shows **Retry** and the task stays available. Later threads on the task only read it.

## Start a thread in a task

Open a new thread and choose the task from **Task** below the composer, or choose **New thread in this task** in the document's header. Project, worktree, and No project choices work as usual. New threads start with **Task: None** unless you start them from a task.

Before the first task thread, choose **Task > Update instructions file...** and enter the path to the file that tells agents how to update tasks.

Each task thread first reads the task, then waits for your work. Messages you send meanwhile stay queued. If the agent cannot read the task, the document shows **Retry** and your messages keep waiting.

## Edit the document

Switching threads in a task keeps your unsaved edits and cursor. Choose **Save**, or press `Ctrl+S` / `Cmd+S`. Nothing saves automatically. Unsaved edits are kept while the app stays open, but not across a reload.

If the file changes on disk with no unsaved edits, the document refreshes. If you have unsaved edits, choose **Keep my draft** or **Use disk version**. You can reverse that choice until you dismiss the notice that follows it.

T3 Code checks for changes before saving, but another app can still write in the instant before the save completes.

On narrow windows, or while a tool is maximized, the task icon in the top-right controls opens the document in a drawer.

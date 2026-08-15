# Tagging files and directories

Type `@` in the web or desktop composer to search for files and directories in the current
project. Selecting a result adds a tag to the message without changing the path sent to the agent.

To browse outside the current project, start the query with an explicit filesystem path:

- `@~/Sites/` browses from your home directory.
- `@../` browses relative to the current project.
- `@/tmp/` browses an absolute path.
- On Windows, drive and UNC paths are also supported.

Use the existing quoted mention form when a directory name contains spaces, for example
`@"~/My Projects/"`.

Browsing happens on the thread's environment, so a remote thread sees the remote filesystem rather
than files on the device running the client. Only the current directory is listed; T3 Code does not
recursively search outside the project.

The picker includes regular files and directories. A tag can always be copied, but opening it from a
sent message is available only when T3 Code can resolve the authored path in that message's
environment.

# Chat Composer

The composer is the box at the bottom of a thread where you write to the agent.

## Images

Drop or paste an image into the composer to attach it. Large images are compressed so they still
fit the send limit. You can attach up to 8 images per message.

## File Mentions

On the desktop app, drop or paste a non-image file or folder into the composer to mention it. T3
Code inserts a chip with the file's path so the agent can read the file where it already lives.

- Files inside the current project are mentioned by their path in the project
- Files outside the project are mentioned by their full path on disk
- Mixed drops attach the images and mention everything else

You can also mention a file from the file tree by dragging it into the composer, or by typing `@`
and picking a path.

### When mentions are available

File mentions from an OS drop or paste only work when you are talking to the environment that is
running on the same computer as the desktop app. They are not available:

- In a browser tab, which cannot see where a dropped file lives on disk
- When the selected environment is remote, SSH, or a relay
- In desktop WSL-only mode, where the agent is on Linux and a dropped file has a Windows path

In those cases T3 Code still accepts images. A non-image file is not inserted, and the thread
explains that only images can be attached.

## Thread Titles

When a new thread starts from a message that mentions files, the suggested title uses the file
names instead of the raw mention markup.

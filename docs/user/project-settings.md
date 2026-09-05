# Project settings

Open **Settings → Projects** and select a project to change its preferences.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to every checkout in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Switch projects from the rail

Turn on **Settings → General → Project rail** to replace the sidebar's project menu with a column of
project icons on the left. Select the top tile to see every project's threads, a project tile to see
only its threads, or the bottom tile to add a project. Hover a tile for the full project name, and
right-click it to open that project's settings. A project with no favicon or chosen icon, whose name
T3 Code cannot place, shows its initials instead.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

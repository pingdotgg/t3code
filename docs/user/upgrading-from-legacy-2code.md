# Upgrading from the earlier 2code desktop app

Existing 2code desktop installations continue to receive updates through their usual update
channel. The updated app keeps the 2code name, app identity, and update feed while moving its new
runtime data into a separate store. It does not replace or share data with a separately installed
T3 Code app.

On the first launch after the upgrade, 2code copies the information it can safely continue from the
earlier app:

- projects;
- resumable Claude and Codex threads;
- thread titles, subtitles, selected models, and saved Claude-to-Codex routing;
- valid Codex bridge sign-in data, when present.

The earlier app's files are only read and copied. They are not moved, rewritten, or deleted. The
upgrade can therefore be retried without damaging the earlier workspace.

Imported threads remain stopped and require approval. Nothing starts running in the background as
part of the upgrade. Open an imported thread and send a follow-up when you want the provider to
resume its existing conversation context. The initial T3-style message view may be empty until that
provider session is resumed; the original provider remains the source of its earlier conversation
history.

Terminal tabs, temporary or background chats, and sessions without a usable provider resume token
are not imported. They remain available in the earlier app's unchanged data.

Remote access is not enabled automatically. Configure it again from Settings if you want this 2code
installation to accept browser or mobile connections.

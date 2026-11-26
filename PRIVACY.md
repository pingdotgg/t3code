# Privacy

Hyakki collects no usage data. It has no analytics, no crash reporting and no tracing of its own,
and it does not send anything about you, your machine or your projects to the people who make it.

What does leave your machine is what you set up:

- **The agents and models you use.** Hyakki starts the coding agents you have installed and signed
  in to (Claude Code, Codex, OpenCode and the others). They talk to their own providers under their
  own terms. Hyakki does not control, see or answer for that traffic.
- **Source control and issue trackers you connect.** GitHub, GitLab, Linear and the rest are only
  contacted when you link them.
- **Updates.** The desktop app checks this repository's GitHub releases for a newer version and
  fetches the published list of models from it.
- **Your own telemetry export.** If you point Settings at an OpenTelemetry endpoint you run, Hyakki
  sends traces and metrics there and nowhere else.

Your threads, settings and history stay in Hyakki's data folder on your computer.

Questions or concerns: open an issue at https://github.com/Ryoku-dev/hyakki/issues.

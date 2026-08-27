# Image generation

T3 Code can generate images through a built-in `generate_image` tool. Any signed-in provider can call it: Claude, Codex, Grok, Cursor, or OpenCode.

Turn it on in Settings → Integrations → Image generation. Pick the image backend there.

## Providers

**Codex** uses the Codex CLI already configured in T3 Code. No extra API key. Images count against Codex usage.

**Grok** uses Grok Imagine with your existing `grok login`. You can pick Imagine 2.0, Imagine Quality, or Imagine.

If the selected backend is missing or signed out, the tool reports that instead of generating.

## Where files go

Generated files are stored in T3 Code's image library on the environment, under userdata `images`. They are not written into your project unless the agent copies them there. Ask it to copy a file into the repo when you want that asset committed.

## Quality and size

The tool defaults aspect ratio to auto. You can ask for `1k` or `2k` resolution and `low`, `medium`, or `high` quality. Grok honors those options on Imagine. Codex gets them as instructions to its built-in image tool.

# Canvas

The Canvas panel is a design canvas next to a thread. You and agents edit the
same document, and changes show up live for everyone viewing it. Canvases
belong to a project and are saved in T3 Code's data directory, not in your
repository.

Open the right panel in a project thread and choose **Canvas**, then create a
canvas or import a design file: `.pen` from pencil.dev, a Figma binary export
(`.fig` or `.figma`), or a `.zip` containing supported files and assets.
Imports report anything skipped or approximated.
SVG, PNG, JPEG, WebP, and GIF exports import as image layers. SVG keeps its vector
source, but its internal paths are not editable. Scripts, animation, embedded HTML,
and external SVG resources are removed; GIF uses the first frame.
To bring in Paper or Framer designs, export an SVG or image from the source tool.
Native Paper, Framer, and Sketch projects, HTML, PDF, PSD, and Illustrator imports are not supported.
Browser uploads support files up to 72 MiB. For larger files, put the file in
the project workspace and ask an agent to import it (up to 256 MiB).

Agents use `canvas_*` tools to list, read, and edit canvases, import a design
file from the workspace, take screenshots, and export a frame as HTML with
Tailwind classes. Screenshots render in your client, so they need T3 Code open
with that canvas loaded; an agent can open it for you with `canvas_open`.
Download a PNG from the canvas toolbar, or select one layer to capture it alone.
Ask an agent to use `canvas_render` to save a snapshot in the thread timeline.
Snapshots preserve shader fills and stay unchanged when you edit the canvas.
They can be viewed on web, desktop, and mobile; capturing requires the canvas
open in a web or desktop client.

Float the canvas over chat to keep a design visible while working with an
agent, then dock it back to edit. Use Play to preview a layer's animation;
HTML exports include its CSS keyframes. The canvas uses a scene document,
so exported Tailwind classes are an output rather than a live HTML editor.
Shader fills need the canvas runtime to render. HTML exports preserve their
source and settings, but do not display those fills on their own.

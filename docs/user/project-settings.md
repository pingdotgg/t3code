# Customize a project

## Icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Default model

You can pin the harness and model that new threads in a project should use.

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **New threads**, choose the **Model**.

That pin applies to every checkout in the project group. It also applies when you start a new
thread in the project, and when you move a draft onto it from another project.

If you have not set a default, new threads keep using the harness and model from the thread you
were looking at, or the last one you picked.

To stop pinning a model, select the reset control next to **Model**.

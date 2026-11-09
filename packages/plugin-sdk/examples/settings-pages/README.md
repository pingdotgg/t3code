# Settings pages

A web-only plugin that opens Settings and Usage as pages in place of the thread, beside the
sidebar, instead of a window over the chat. While Settings is open, the sidebar lists its sections
where the threads were, on wide screens and in the phone's sheet. Back at the bottom of the
sidebar and Esc go back to the thread. On phones, and while the sidebar is closed, the pages keep
T3's close button.

First build its web half with `vp run build:examples` in `packages/plugin-sdk`. Then install it
by dragging this folder onto **Settings → Plugins**, or with **Add plugin → Choose folder**.

It replaces the `app.pageFrame` part with the `page` piece T3 hands it, and the `app.sidebar` part
with T3's header, Settings' `nav` in place of `threads`, and `back` in place of `footer`. T3 draws
the page's header as the window's title bar row, so the plugin has no stylesheet.

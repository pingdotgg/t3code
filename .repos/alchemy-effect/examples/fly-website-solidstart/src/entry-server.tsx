// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>SolidStart on Fly</title>
          {assets}
        </head>
        <body class="bg-slate-50 p-8 text-slate-900">
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));

import { test as aliasTest } from "@alias/test";
import { legacyMessage } from "@fixtures/legacy-main-fields-package";
import { featureMessage } from "@fixtures/module-resolution-package/feature";
import { packageMessage } from "@fixtures/module-resolution-package";
import { helloWorldExt } from "./requires/ext";
import { helloWorldNoExt } from "./requires/no-ext";

export default {
  async fetch(request: Request) {
    const pathname = new URL(request.url).pathname;

    switch (pathname) {
      case "/package-export":
        return Response.json({ packageMessage });
      case "/package-subpath":
        return Response.json({ featureMessage });
      case "/package-main-fields":
        return Response.json({ legacyMessage });
      case "/require-ext":
        return Response.json({ helloWorldExt });
      case "/require-no-ext":
        return Response.json({ helloWorldNoExt });
      case "/@alias/test":
        return aliasTest();
      default:
        return new Response(null, { status: 404 });
    }
  },
} satisfies ExportedHandler;

import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import { ListMicrovmImageBuilds } from "./ListMicrovmImageBuilds.ts";
import { makeImageBinding } from "./MicrovmBinding.ts";

export const ListMicrovmImageBuildsHttp = makeImageBinding({
  binding: ListMicrovmImageBuilds,
  name: "ListMicrovmImageBuilds",
  actions: ["lambda:ListMicrovmImageBuilds"],
  operation: microvms.listMicrovmImageBuilds,
  scope: "image",
  injectImageIdentifier: true,
});

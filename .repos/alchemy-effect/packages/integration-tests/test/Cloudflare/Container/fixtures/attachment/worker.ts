import { Container, getContainer } from "@cloudflare/containers";

export class AttachmentContainerObject extends Container {
  defaultPort = 8080;
}

export default {
  fetch(request: Request, env: { ECHO: DurableObjectNamespace<AttachmentContainerObject> }) {
    return getContainer(env.ECHO, "default").fetch(request);
  },
};

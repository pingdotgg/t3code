import { connect } from "cloudflare:sockets";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export default {
  "(cloudflare:workers) WorkerEntrypoint.name": WorkerEntrypoint.name,
  "(cloudflare:workers) DurableObject.name": DurableObject.name,
  "(cloudflare:sockets) typeof connect": typeof connect,
};

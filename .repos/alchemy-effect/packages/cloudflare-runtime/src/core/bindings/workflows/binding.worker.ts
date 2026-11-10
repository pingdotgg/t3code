// Re-export the vendored `WorkflowBinding` entrypoint and `Engine` Durable
// Object class so they get bundled into the workflows engine service worker.
export {
  Engine,
  WorkflowBinding,
} from "../../../internal/workflows-shared/local-binding-worker.ts";

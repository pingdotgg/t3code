import { configure } from "arktype/config";

// workerd forbids JIT compilation during requests, even when isolate startup allows it.
configure({ jitless: true });

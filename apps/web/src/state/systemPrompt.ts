/**
 * Web bindings for the system prompt injection settings (fork f2).
 *
 * The rules themselves ride `ServerSettings`, so there is nothing to fetch —
 * only the capability gate, which decides whether the settings section is
 * editable or shows an explainer for an upstream server.
 */
import { Atom } from "effect/unstable/reactivity";

import { primaryServerConfigAtom } from "./server";

export const primarySupportsSystemPromptInjectionAtom = Atom.make(
  (get): boolean =>
    get(primaryServerConfigAtom)?.environment.capabilities.systemPromptInjection === true,
).pipe(Atom.withLabel("web-primary-supports-system-prompt-injection"));

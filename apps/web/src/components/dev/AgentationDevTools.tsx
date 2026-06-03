import { Agentation } from "agentation";

/**
 * Dev-only UI annotation toolbar for giving agents structured feedback.
 * See https://www.agentation.com/install
 */
export function AgentationDevTools() {
  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <Agentation
      className="z-[60]"
      endpoint="http://localhost:4747"
      onSessionCreated={(sessionId) => {
        console.debug("[agentation] session started:", sessionId);
      }}
    />
  );
}

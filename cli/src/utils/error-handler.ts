/**
 * Centralised error handler for CLI-level failures.
 * Called at the top level of commands — not inside the Ink render tree.
 */
export function handleFatalError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);

  if (isApiKeyError(message)) {
    console.error("\nInvalid or missing API key.");
    console.error("Run: t3code config\n");
  } else if (isRateLimitError(message)) {
    console.error("\nRate limit exceeded. Wait a moment and try again.\n");
  } else if (isNetworkError(message)) {
    console.error("\nNetwork error — check your connection and try again.\n");
  } else if (isContextLengthError(message)) {
    console.error(
      "\nContext window exceeded. Start a new session with Ctrl+R or t3code start.\n",
    );
  } else {
    console.error(`\nError: ${message}`);
    if (process.env["DEBUG"]) {
      console.error(err instanceof Error ? err.stack : err);
    } else {
      console.error("Run with DEBUG=1 for a full stack trace.\n");
    }
  }

  process.exit(1);
}

function isApiKeyError(msg: string): boolean {
  return (
    msg.includes("401") ||
    msg.includes("authentication") ||
    msg.includes("api_key") ||
    msg.includes("API key")
  );
}

function isRateLimitError(msg: string): boolean {
  return msg.includes("429") || msg.toLowerCase().includes("rate limit");
}

function isNetworkError(msg: string): boolean {
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed")
  );
}

function isContextLengthError(msg: string): boolean {
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context") ||
    msg.includes("too long")
  );
}

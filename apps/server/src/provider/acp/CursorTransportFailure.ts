const maxLineLength = 4096;
const transportError =
  /^Error: (?:RetriableError: .+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/;
const serverError = "Something went wrong communicating with the server. Please try again.";

interface ReplyState {
  disqualified: boolean;
  failure: string | undefined;
}

function consumeLine(state: ReplyState, line: string) {
  if (state.disqualified) return;
  const text = line.trimEnd();
  if (transportError.test(text) || text === serverError) {
    state.failure = text;
  } else if (text.trim() !== "" && !(state.failure && /^\s+at\s/.test(text))) {
    // An explanation or code sample can quote the same diagnostic. Only
    // classify an assistant item consisting entirely of a transport dump.
    state.disqualified = true;
    state.failure = undefined;
  }
}

/** Tracks a standalone Cursor diagnostic without retaining an entire streamed answer. */
export class CursorTransportFailure {
  private state: ReplyState = { disqualified: false, failure: undefined };
  private line = "";

  push(text: string) {
    for (const [index, part] of text.split("\n").entries()) {
      if (this.state.disqualified) return;
      if (index > 0) {
        consumeLine(this.state, this.line);
        this.line = "";
      }
      if (this.line.length + part.length > maxLineLength) {
        this.state.disqualified = true;
        this.state.failure = undefined;
        this.line = "";
        return;
      }
      this.line += part;
    }
  }

  get failure() {
    const state = { ...this.state };
    consumeLine(state, this.line);
    return state.failure;
  }
}

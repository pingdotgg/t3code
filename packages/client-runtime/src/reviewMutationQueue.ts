/** Project clicks immediately, then write Git in order without locking the reader. */
export class OptimisticReviewMutationQueue<State, Mutation> {
  private pending: Mutation[] = [];
  private draining = false;
  private tail: Promise<void> = Promise.resolve();

  private committed: State;
  private readonly operations: {
    apply: (state: State, mutation: Mutation) => State;
    send: (mutation: Mutation) => Promise<boolean>;
    onSnapshot: (state: State, pendingCount: number) => void;
    onFailure: (mutation: Mutation, error?: unknown) => void;
  };

  constructor(
    committed: State,
    operations: OptimisticReviewMutationQueue<State, Mutation>["operations"],
  ) {
    this.committed = committed;
    this.operations = operations;
  }

  enqueue(mutation: Mutation) {
    this.pending.push(mutation);
    this.publish();
    if (!this.draining) {
      this.draining = true;
      this.tail = this.drain();
    }
  }

  settled() {
    return this.tail;
  }

  private publish() {
    this.operations.onSnapshot(
      this.pending.reduce(this.operations.apply, this.committed),
      this.pending.length,
    );
  }

  private async drain() {
    while (this.pending.length) {
      const mutation = this.pending[0]!;
      let success = false;
      let error: unknown;
      try {
        success = await this.operations.send(mutation);
      } catch (cause) {
        error = cause;
      }
      if (success) this.committed = this.operations.apply(this.committed, mutation);
      this.pending.shift();
      this.publish();
      if (!success) this.operations.onFailure(mutation, error);
    }
    this.draining = false;
  }
}

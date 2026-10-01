/** Bind pull delivery to the installed client's lifetime, including a pending next(). */
export function installedStream<A>(
  open: (signal: AbortSignal) => AsyncIterable<A>,
  lifetime: AbortSignal,
  validate: () => void,
): AsyncIterable<A> {
  return {
    [Symbol.asyncIterator]() {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetime]);
      let iterator: AsyncIterator<A> | undefined;
      let pulling = false;
      let closed = false;
      let cleanup: Promise<void> | undefined;
      const close = () => {
        if (cleanup) return cleanup;
        closed = true;
        signal.removeEventListener("abort", cancelled);
        controller.abort();
        cleanup = Promise.resolve(iterator?.return?.()).then(() => {});
        return cleanup;
      };
      const cancelled = () => {
        void close().catch(() => {});
      };
      signal.addEventListener("abort", cancelled, { once: true });
      return {
        async next(): Promise<IteratorResult<A>> {
          if (closed || signal.aborted) {
            await close();
            return { done: true, value: undefined };
          }
          if (pulling) throw new Error("Only one extension stream pull may be pending");
          pulling = true;
          try {
            validate();
            iterator ??= open(signal)[Symbol.asyncIterator]();
            const result = await iterator.next();
            if (signal.aborted) throw new Error("Installed API stream expired");
            validate();
            if (result.done) await close();
            return result;
          } catch (error) {
            await close();
            throw error;
          } finally {
            pulling = false;
          }
        },
        async return(): Promise<IteratorResult<A>> {
          await close();
          return { done: true, value: undefined };
        },
        async throw(error: unknown): Promise<IteratorResult<A>> {
          await close();
          throw error;
        },
      };
    },
  };
}

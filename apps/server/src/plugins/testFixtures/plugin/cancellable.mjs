// Settles only from its abort listener, as a handler that honours cancellation does.
export function activate(context) {
  context.proposed.handle(
    "cooperative",
    (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")));
      }),
  );
}

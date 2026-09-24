"use client";

// Client error boundary: renders in the browser after the server render
// of the segment throws.
export default function BoomError({ error: _error, reset }) {
  return (
    <main>
      <h1>ERROR_BOUNDARY_MARKER</h1>
      <button type="button" onClick={() => reset()}>
        Retry
      </button>
    </main>
  );
}

// On AWS the server runs in a plain Node Hetzner Server, so environment values
// declared in alchemy.run.ts are read from `process.env`.
export const load = () => {
  return {
    greeting: process.env.GREETING ?? "Hello!",
  };
};

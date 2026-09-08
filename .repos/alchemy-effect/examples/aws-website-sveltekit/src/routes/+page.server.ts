// On AWS the server runs in a plain Node Lambda, so environment values
// declared in alchemy.run.ts are read from `process.env`.
export const load = () => {
  return {
    greeting: process.env.GREETING ?? "Hello!",
  };
};

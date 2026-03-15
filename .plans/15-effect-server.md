Rewrite `createServer` and `index.ts` to be Effect native.

Maybe use `effect/unstable/Socket` for the web socket server

- https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/unstable/socket/SocketServer.ts
- https://github.com/Effect-TS/effect-smol/blob/main/packages/platform-node/test/NodeSocket.test.ts

- Migrate remaining runtime code to Effect
  - `gitManager` -> `src/git`
  - `terminalManager` -> `src/terminal` (Manager + PTY)
  - ...

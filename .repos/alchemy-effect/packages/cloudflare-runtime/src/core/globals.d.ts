declare module "cloudflare-internal:sockets" {
  const sockets: { connect: typeof import("cloudflare:sockets").connect };
  export default sockets;
}

declare module "workerd" {
  const bin:
    | string // it should be the binary path
    | {
        // but their exports are weird so sometimes it's this
        default: string;
        compatibilityDate: string;
        version: string;
      };
  export default bin;
  export const compatibilityDate: string;
  export const version: string;
}

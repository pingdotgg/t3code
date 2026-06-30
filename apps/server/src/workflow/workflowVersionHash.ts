import * as NodeCrypto from "node:crypto";

export const sha256Hex = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

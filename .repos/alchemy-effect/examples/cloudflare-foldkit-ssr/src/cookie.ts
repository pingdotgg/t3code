import { Number, Option, Record, pipe } from "effect";
import * as Cookies from "effect/http/Cookies";

export const COUNT_COOKIE = "count";

export const readCountCookie = (cookieHeader: string): number =>
  pipe(
    Cookies.parseHeader(cookieHeader),
    Record.get(COUNT_COOKIE),
    Option.flatMap(Number.parse),
    Option.filter(globalThis.Number.isSafeInteger),
    Option.getOrElse(() => 0),
  );

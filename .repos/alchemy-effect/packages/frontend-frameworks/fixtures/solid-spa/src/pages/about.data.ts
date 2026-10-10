import { createAsync, query } from "@solidjs/router";

function wait<T>(ms: number, data: T): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, ms, data));
}

function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const getName = query(() => wait(random(500, 1000), "Solid"), "aboutName");

const AboutData = () => {
  return createAsync(() => getName());
};

export default AboutData;
export type AboutDataType = typeof AboutData;

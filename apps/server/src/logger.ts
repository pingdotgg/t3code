import { createRequire } from "node:module";

import pino, { type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from "pino";

type LogContext = Record<string, unknown>;

type PrettyFactory = ((options: PrettyOptions) => DestinationStream) & {
  readonly isColorSupported?: boolean;
};

interface PrettyOptions {
  readonly colorize?: boolean;
  readonly ignore: string;
  readonly messageFormat: string;
  readonly singleLine: boolean;
  readonly translateTime: string;
}

export interface CreateLoggerOptions {
  readonly destination?: DestinationStream;
  readonly isTty?: boolean;
  readonly nodeEnv?: string | undefined;
  readonly prettyFactory?: PrettyFactory | null;
}

const requireForLogger = createRequire(import.meta.url);
let sharedLogger: PinoLogger | null = null;

function createPinoLogger(options: CreateLoggerOptions = {}): PinoLogger {
  const loggerOptions: LoggerOptions = {
    level: "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  const destination = options.destination ?? resolvePrettyDestination(options);
  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}

function getSharedLogger() {
  sharedLogger ??= createPinoLogger();
  return sharedLogger;
}

function resolvePrettyDestination(options: CreateLoggerOptions): DestinationStream | null {
  const isTty = options.isTty ?? process.stdout.isTTY === true;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (!isTty || nodeEnv === "production") {
    return null;
  }

  const prettyFactory = options.prettyFactory ?? loadPrettyFactory();
  if (!prettyFactory) {
    return null;
  }

  const colorize = prettyFactory.isColorSupported;
  const prettyOptions: PrettyOptions = {
    ...(typeof colorize === "boolean" ? { colorize } : {}),
    ignore: "pid,hostname,scope",
    messageFormat: "{if scope}[{scope}] {end}{msg}",
    singleLine: true,
    translateTime: "SYS:HH:MM:ss.l",
  };
  return prettyFactory(prettyOptions);
}

function loadPrettyFactory(): PrettyFactory | null {
  try {
    return requireForLogger("pino-pretty") as PrettyFactory;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "MODULE_NOT_FOUND" &&
      error.message.includes("'pino-pretty'")
    ) {
      return null;
    }
    throw error;
  }
}

function write(
  logger: PinoLogger,
  level: "info" | "warn" | "error",
  message: string,
  context?: LogContext,
) {
  if (context && Object.keys(context).length > 0) {
    logger[level](context, message);
    return;
  }
  logger[level](message);
}

function writeEvent(logger: PinoLogger, message: string, context?: LogContext) {
  logger.info(
    {
      ...context,
      type: "event",
    },
    message,
  );
}

export function createLogger(scope: string, options?: CreateLoggerOptions) {
  const logger = (options ? createPinoLogger(options) : getSharedLogger()).child({ scope });
  return {
    info(message: string, context?: LogContext) {
      write(logger, "info", message, context);
    },
    warn(message: string, context?: LogContext) {
      write(logger, "warn", message, context);
    },
    error(message: string, context?: LogContext) {
      write(logger, "error", message, context);
    },
    event(message: string, context?: LogContext) {
      writeEvent(logger, message, context);
    },
  };
}

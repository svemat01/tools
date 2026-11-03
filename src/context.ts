/**
 * The application context: runtime services shared by all handlers.
 *
 * Handlers that only need the base facilities (stdout, env, signal, ...) take
 * the default `BaseContext`; handlers that use these services annotate their
 * second parameter as `AppContext`. `createApp()` verifies the app provides it.
 */
import { resolve } from "node:path";

import type { BaseContext, ModelOfElement } from "./kit/index.ts";
import type { globalOptions } from "./options.ts";

export interface Logger {
  info(message: string): void;
  debug(message: string): void;
}

export interface AppContext extends BaseContext {
  readonly log: Logger;
}

type RootModel = ModelOfElement<typeof globalOptions>;

/** Root options configure services; they are not flattened into the context. */
export function createContext(
  base: BaseContext,
  intent: { readonly models: { readonly "/": RootModel } },
): AppContext {
  const { verbose, cwd } = intent.models["/"];
  return {
    ...base,
    cwd: cwd === undefined ? base.cwd : resolve(base.cwd, cwd),
    log: {
      info: (message) => base.stderr.write(`${message}\n`),
      debug: (message) => {
        if (verbose) base.stderr.write(`debug: ${message}\n`);
      },
    },
  };
}

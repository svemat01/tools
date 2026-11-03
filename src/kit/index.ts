/**
 * The thin Router + Tab integration layer.
 *
 * Define commands with native `@bomb.sh/router` elements, attach handlers with
 * `defineCommand()`, annotate parameters with `complete()`, and compose with
 * Router's own `route()`/`command()`/`extend()`. `createApp()` verifies the
 * composed tree and runs it.
 */
export {
  createApp,
  AppDefinitionError,
  type App,
  type AppOptions,
  type AppOptionsWithContext,
  type ExecuteIntent,
  type Settled,
  type Sources,
  type Step,
} from "./app.ts";
export {
  defineCommand,
  type AncestorModels,
  type AncestorSources,
  type CommandIntent,
  type ExitCode,
  type HandlerResult,
  type ModelOfElement,
  type TabHookInfo,
} from "./command.ts";
export {
  complete,
  directories,
  files,
  type CompletionSource,
  type PathCompletion,
  type TabHandler,
} from "./complete.ts";
export type { BaseContext, Output, RunOptions } from "./context.ts";
export { describeRoute, flattenRoutes, type ParamMeta, type RouteMeta } from "./router-meta.ts";
export { shells, type CompletionResult, type Shell, type TabTree } from "./tab.ts";
export type { ContextOf, ExecuteAt, Problems, RoutePaths, Verify } from "./verify.ts";

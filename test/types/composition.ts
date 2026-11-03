/**
 * Compile-time tests: composing command trees and verifying them in createApp().
 */

import { expectTypeOf } from "bun:test";

import {
  type AnyRoute,
  checkpoint,
  command,
  description,
  extend,
  name,
  option,
  route,
  schema,
  toggle,
} from "@bomb.sh/router";
import { z } from "zod";

import {
  type BaseContext,
  createApp,
  defineCommand,
  type ExecuteIntent,
  type RoutePaths,
  type Step,
} from "../../src/kit/index.ts";

const rootOptions = extend(toggle(name("verbose")));
const mediaOptions = extend(option(name("quality"), schema(z.number().default(80))));

const web = defineCommand(command(name("web"), option(name("quality"), schema(z.number().optional()))), {
  inherit: { root: rootOptions, media: mediaOptions },
  run() {},
});
const og = defineCommand(command(name("og")), { run() {} });

// Modules can export their commands as tuples; `as const` keeps them precise.
const mediaCommands = [web, og] as const;
const media = route(name("media"), description("Media"), mediaOptions, ...mediaCommands);

const deep = defineCommand(command(name("deep")), { run() {} });
const nested = route(name("one"), route(name("two"), route(name("three"), deep)));

const runnableGroup = defineCommand(command(name("dev"), toggle(name("json")), og), { run() {} });

const root = defineCommand(command(name("sv"), rootOptions, media, nested, runnableGroup), { run() {} });

// --- The composed tree keeps every path ---------------------------------------

expectTypeOf<RoutePaths<typeof root>>().toEqualTypeOf<
  | "/"
  | "/media"
  | "/media/web"
  | "/media/og"
  | "/one"
  | "/one/two"
  | "/one/two/three"
  | "/one/two/three/deep"
  | "/dev"
  | "/dev/og"
>();

const app = createApp(root);

// Router's own intent types survive composition: parent models are typed by path.
declare const intent: ExecuteIntent<typeof root>;
if (intent.route === "/media/web") {
  expectTypeOf(intent.models["/"]).toEqualTypeOf<{ verbose: boolean }>();
  expectTypeOf(intent.models["/media"]).toEqualTypeOf<{ quality: number }>();
  expectTypeOf(intent.model).toEqualTypeOf<{ quality: number | undefined }>();
}
if (intent.route === "/one/two/three/deep") {
  expectTypeOf<keyof typeof intent.models>().toEqualTypeOf<
    "/" | "/one" | "/one/two" | "/one/two/three" | "/one/two/three/deep"
  >();
}
void app;

// --- createApp() rejects unsound trees ---------------------------------------

// A command mounted without an applier for its inherited bundle.
// @ts-expect-error no route provides the media bundle model
createApp(route(name("sv"), rootOptions, web));

// An ancestor that does not provide the declared model.
const wrongRoot = extend(option(name("verbose"), schema(z.string())));
// @ts-expect-error "/" provides verbose: string, web expects boolean
createApp(route(name("sv"), wrongRoot, media));

// Executable commands need handlers.
// @ts-expect-error /plain is executable but has no handler
createApp(command(name("sv"), command(name("plain"))));

// Root executable without a handler is also caught.
// @ts-expect-error / is executable but has no handler
createApp(command(name("sv"), media));

// A plain route() root needs no handler.
createApp(route(name("sv"), rootOptions, media));

// Duplicate sibling names.
// @ts-expect-error /og is declared twice
createApp(route(name("sv"), og, og));

// Reserved by the completion protocol.
// @ts-expect-error "complete" is reserved at the root
createApp(route(name("sv"), defineCommand(command(name("complete")), { run() {} })));

// Widening: an AnyRoute[] loses every path and model, so it is rejected.
const widened: AnyRoute[] = [og];
// @ts-expect-error the tree was widened to AnyRoute
createApp(route(name("sv"), ...widened));

// --- Application context -------------------------------------------------------

type WithClock = BaseContext & { readonly now: () => number };
const timed = defineCommand(command(name("timed")), {
  run(_intent, context: WithClock) {
    void context.now();
  },
});

// @ts-expect-error the handler needs `now`, the app provides only BaseContext
createApp(route(name("sv"), timed));

createApp(route(name("sv"), timed), { context: (base) => ({ ...base, now: () => 0 }) });

// @ts-expect-error the factory's context lacks `now`
createApp(route(name("sv"), timed), { context: (base) => ({ ...base, later: () => 0 }) });

// The factory sees the tree's execute intents, so root options are typed.
createApp(defineCommand(command(name("sv"), rootOptions, timed), { run() {} }), {
  context: (base, execute) => {
    expectTypeOf(execute.models["/"].verbose).toEqualTypeOf<boolean>();
    return { ...base, now: () => (execute.models["/"].verbose ? 1 : 0) };
  },
});

// --- Checkpoints require a driver, typed by Router's increments ---------------

const configured = defineCommand(
  command(
    name("cfg"),
    option(name("config"), schema(z.string().optional())),
    checkpoint(),
    option(name("port")),
  ),
  { run() {} },
);

// @ts-expect-error a tree with checkpoints needs a checkpoint driver
createApp(configured);

createApp(configured, {
  checkpoint(step: Step<typeof configured>) {
    expectTypeOf(step.route).toEqualTypeOf<"/">();
    expectTypeOf(step.model).toEqualTypeOf<{ config: string | undefined }>();
    // @ts-expect-error resume() takes value sources, typed by Router
    void step.resume("nope");
    return step.resume([{ name: "file", value: { port: 1 } }]);
  },
});

// Mount paths and intervening groups do not affect bundle inheritance.
createApp(route(name("sv"), rootOptions, route(name("renamed"), mediaOptions, route(name("nested"), web))));
createApp(
  route(name("sv"), rootOptions, route(name("a"), mediaOptions, web), route(name("b"), mediaOptions, web)),
);

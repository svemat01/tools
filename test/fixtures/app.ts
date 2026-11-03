import type { Step } from "../../src/kit/index.ts";
import { createApp } from "../../src/kit/index.ts";
import { fx } from "./tree.ts";

/** Checkpoint driver used by the fixture app: no I/O, deterministic. */
export function drive(step: Step<typeof fx>) {
  switch (step.route) {
    case "/config":
      return step.resume([{ name: "fixture", value: { port: 9000 } }]);
    case "/plugins":
      return step.resume(["hello", "world"]);
  }
}

export function fixtureApp() {
  return createApp(fx, {
    checkpoint: drive,
    context: (base, intent) => ({ ...base, rootName: intent.models["/"].name }),
  });
}

#!/usr/bin/env bun
import { app } from "./app.ts";

const controller = new AbortController();
// First Ctrl-C asks handlers to stop via `context.signal`; a second one kills.
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

process.exitCode = await app.run(process.argv.slice(2), { signal: controller.signal });

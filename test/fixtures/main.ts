// Executable entry for the fixture app, used by the real-shell tests.
import { fixtureApp } from "./app.ts";

process.exitCode = await fixtureApp().run(process.argv.slice(2));

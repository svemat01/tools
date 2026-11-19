import { createServer } from "node:net";

import { argument, command, description, extend, name, schema } from "@bomb.sh/router";
import { z } from "zod";

import { type BaseContext, defineCommand, type ModelOfElement } from "../kit/index.ts";
import { requireBinary } from "../lib/process.ts";

const bindHost = "127.0.0.1";
const maxPort = 65535;
const portNumber = z
  .string()
  .regex(/^\d+$/, "Expected a TCP port number")
  .transform(Number)
  .pipe(z.number().int().min(1).max(maxPort));

const forwardArguments = extend(
  argument(
    name("destination"),
    description("SSH host, alias, or user@host"),
    schema(z.string().regex(/^[^\s-]\S*$/, "Expected an SSH host, alias, or user@host")),
  ),
  argument(name("target-port"), description("TCP port on the SSH host"), schema(portNumber)),
  argument(
    name("local-port"),
    description("Optional exact local port (defaults to the first free port at or above the target port)"),
    schema(portNumber.optional()),
  ),
);

export const portForward = defineCommand(
  command(name("port-forward"), description("Forward a remote TCP port over SSH"), forwardArguments),
  { run: runPortForward },
);
export const pf = defineCommand(
  command(name("pf"), description("Shorthand for port-forward"), forwardArguments),
  {
    run: runPortForward,
  },
);

async function runPortForward(
  { model }: { model: ModelOfElement<typeof forwardArguments> },
  context: BaseContext,
) {
  context.signal.throwIfAborted();
  const ssh = requireBinary("ssh", context.env, "Install the OpenSSH client.");
  const { destination, "target-port": targetPort, "local-port": localPort } = model;
  const port = await findLocalPort(localPort ?? targetPort, localPort !== undefined, context.signal);
  context.signal.throwIfAborted();

  context.stdout.write(
    `Opening SSH forward on ${bindHost}:${port} to port ${targetPort} via ${destination} (Ctrl+C to stop).\n`,
  );
  const child = Bun.spawn(
    [
      ssh,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ClearAllForwardings=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ForkAfterAuthentication=no",
      "-L",
      `${bindHost}:${port}:localhost:${targetPort}`,
      "--",
      destination,
    ],
    {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      signal: context.signal,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await child.exited;
  return context.signal.aborted || code === 0 ? 0 : 1;
}

async function findLocalPort(start: number, exact: boolean, signal: AbortSignal): Promise<number> {
  for (let port = start; port <= maxPort; port++) {
    signal.throwIfAborted();
    try {
      await probePort(port);
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (exact) throw new Error(`Local port ${port} is already in use.`, { cause: error });
    }
  }
  throw new Error(`No free local TCP port from ${start} through ${maxPort}.`);
}

function probePort(port: number): Promise<void> {
  // OpenSSH binds after authentication. ExitOnForwardFailure also catches a later collision.
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy()).once("error", reject);
    server.listen(port, bindHost, () => server.close((error) => (error ? reject(error) : resolve())));
  });
}

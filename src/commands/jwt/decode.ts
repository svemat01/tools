import { argument, cli, command, description, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { claimState, decodeToken } from "../../lib/jwt.ts";
import { color, formatDuration, json, useColor } from "../../lib/output.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";
import { checkStdin, readToken } from "./input.ts";

function describeTime(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const past = seconds < 0;
  const absolute = Math.abs(seconds);
  return past ? `${formatDuration(absolute * 1000)} ago` : `in ${formatDuration(absolute * 1000)}`;
}

export const decode = defineCommand(
  command(
    name("decode"),
    description("Decode a JWT without verifying its signature"),
    argument(
      name("token"),
      description("The JWT to decode"),
      schema(z.string().optional()),
    ),
    option(
      name("file"),
      cli(["--file", "-f"]),
      description("Read the token from a file"),
      schema(z.string().optional()),
      complete(files()),
    ),
    toggle(name("stdin"), description("Read the token from stdin")),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      checkStdin({ tokenStdin: model.stdin });
      const token = await readToken(
        {
          ...(model.token === undefined ? {} : { token: model.token }),
          ...(model.file === undefined ? {} : { file: model.file }),
          stdin: model.stdin,
        },
        context,
      );
      const decoded = decodeToken(token);
      const claims = claimState(decoded.payload);

      if (model.json) {
        context.stdout.write(
          json({
            command: "jwt decode",
            verified: false,
            header: decoded.header,
            payload: decoded.payload,
            signature: decoded.signature,
            claims,
          }),
        );
        return 0;
      }

      const useColour = useColor(context.stdout, context.env);
      context.stdout.write(`${color("Header (not verified)", "bold", useColour)}\n${json(decoded.header)}`);
      context.stdout.write(`${color("Payload", "bold", useColour)}\n${json(decoded.payload)}`);

      const lines: string[] = [];
      if (claims.issuedAt !== undefined) {
        lines.push(`  iat  ${new Date(claims.issuedAt * 1000).toISOString()}`);
      }
      if (claims.notBefore !== undefined) {
        lines.push(
          `  nbf  ${new Date(claims.notBefore * 1000).toISOString()} (${describeTime(
            claims.notBefore - Math.floor(Date.now() / 1000),
          )})`,
        );
      }
      if (claims.expiresAt !== undefined) {
        lines.push(
          `  exp  ${new Date(claims.expiresAt * 1000).toISOString()} (${describeTime(
            claims.secondsRemaining,
          )})`,
        );
      }
      lines.push(
        claims.expired
          ? "  status  expired"
          : claims.notYetValid
            ? "  status  not yet valid"
            : "  status  currently valid",
      );
      context.stdout.write(`${color("Claims", "bold", useColour)}\n${lines.join("\n")}\n`);
      context.stdout.write(
        `${color("Signature", "bold", useColour)} ${decoded.signature}\n` +
          "The signature was not checked. Run `sv jwt verify` to verify it.\n",
      );
      return 0;
    },
  },
);

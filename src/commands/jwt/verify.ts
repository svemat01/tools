import { argument, cli, command, description, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";
import { claimState, JWT_ALGORITHMS, readSecret, verifyJwt } from "../../lib/jwt.ts";
import { color, formatDuration, json, useColor } from "../../lib/output.ts";
import { checkStdin, readToken, secretSource } from "./input.ts";

export const verify = defineCommand(
  command(
    name("verify"),
    description("Verify a JWT signature and standard claims using an explicit algorithm"),
    argument(name("token"), description("The JWT to verify"), schema(z.string().optional())),
    option(
      name("file"),
      cli(["--file", "-f"]),
      description("Read the token from a file"),
      schema(z.string().optional()),
      complete(files()),
    ),
    toggle(name("stdin"), description("Read the token from stdin")),
    option(
      name("alg"),
      description("Algorithm to accept; required so the token cannot choose its own"),
      schema(z.enum(JWT_ALGORITHMS).optional()),
      complete([...JWT_ALGORITHMS]),
    ),
    option(
      name("secretEnv"),
      description("Read the key from this environment variable"),
      schema(z.string().optional()),
    ),
    option(
      name("secretFile"),
      description("Read the key (HMAC secret or SubjectPublicKeyInfo PEM) from this file"),
      schema(z.string().optional()),
      complete(files()),
    ),
    toggle(name("secretStdin"), description("Read the key from stdin")),
    option(
      name("issuer"),
      cli(["--issuer", "--iss"]),
      description("Require this iss claim"),
      schema(z.string().optional()),
    ),
    option(
      name("audience"),
      cli(["--audience", "--aud"]),
      description("Require this aud claim"),
      schema(z.string().optional()),
    ),
    option(
      name("clockTolerance"),
      description("Allowed clock skew in seconds"),
      schema(z.number().int().min(0).default(0)),
    ),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      checkStdin({ tokenStdin: model.stdin, secretStdin: model.secretStdin });
      if (model.alg === undefined) {
        throw new Error(
          "Provide --alg explicitly (for example --alg HS256). The token header is never trusted to choose an algorithm.",
        );
      }

      const token = await readToken(
        {
          ...(model.token === undefined ? {} : { token: model.token }),
          ...(model.file === undefined ? {} : { file: model.file }),
          stdin: model.stdin,
        },
        context,
      );
      const source = secretSource({
        ...(model.secretEnv === undefined ? {} : { secretEnv: model.secretEnv }),
        ...(model.secretFile === undefined ? {} : { secretFile: model.secretFile }),
        secretStdin: model.secretStdin,
      });
      const secret = await readSecret(source, {
        env: context.env,
        cwd: context.cwd,
        readStdin: context.readStdin,
      });

      try {
        const result = await verifyJwt(token, {
          algorithm: model.alg,
          secret,
          ...(model.issuer === undefined ? {} : { issuer: model.issuer }),
          ...(model.audience === undefined ? {} : { audience: model.audience }),
          clockTolerance: model.clockTolerance,
        });
        const claims = claimState(result.payload);

        if (model.json) {
          context.stdout.write(
            json({
              command: "jwt verify",
              valid: true,
              algorithm: model.alg,
              header: result.header,
              payload: result.payload,
              claims,
            }),
          );
        } else {
          const useColour = useColor(context.stdout, context.env);
          context.stdout.write(`${color("Token is valid.", "green", useColour)}  ${model.alg}\n`);
          if (claims.expiresAt !== undefined) {
            context.stdout.write(
              `  exp  ${new Date(claims.expiresAt * 1000).toISOString()} (${formatDuration(
                Math.abs(claims.secondsRemaining ?? 0) * 1000,
              )} ${claims.expired ? "ago" : "remaining"})\n`,
            );
          }
          context.stdout.write(`\n${json(result.payload)}`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (model.json) {
          context.stdout.write(
            json({
              command: "jwt verify",
              valid: false,
              algorithm: model.alg,
              error: message,
            }),
          );
        } else {
          context.stderr.write(`invalid: ${message}\n`);
        }
        return 1;
      }
    },
  },
);

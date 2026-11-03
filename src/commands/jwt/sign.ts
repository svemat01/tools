import { cli, command, description, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { JWT_ALGORITHMS, decodeToken, parseDuration, readSecret, signJwt } from "../../lib/jwt.ts";
import { json } from "../../lib/output.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";
import { checkStdin, readPayload, secretSource } from "./input.ts";

export const sign = defineCommand(
  command(
    name("sign"),
    description("Sign a JWT using a secret from the environment, a file, or stdin"),
    option(
      name("alg"),
      description("Signing algorithm"),
      schema(z.enum(JWT_ALGORITHMS).default("HS256")),
      complete([...JWT_ALGORITHMS]),
    ),
    option(
      name("secretEnv"),
      description("Read the secret from this environment variable"),
      schema(z.string().optional()),
    ),
    option(
      name("secretFile"),
      description("Read the secret (HMAC key or PKCS#8 PEM) from this file"),
      schema(z.string().optional()),
      complete(files()),
    ),
    toggle(name("secretStdin"), description("Read the secret from stdin")),
    option(
      name("payload"),
      description("Inline JSON payload object"),
      schema(z.string().optional()),
    ),
    option(
      name("payloadFile"),
      description("Read the JSON payload from a file"),
      schema(z.string().optional()),
      complete(files({ extensions: ["json"] })),
    ),
    toggle(name("payloadStdin"), description("Read the JSON payload from stdin")),
    option(
      name("expiresIn"),
      cli(["--expires-in", "--exp"]),
      description("Expiration, e.g. 30s, 15m, 1h, 7d"),
      schema(z.string().optional()),
    ),
    option(name("issuer"), cli(["--issuer", "--iss"]), description("iss claim"), schema(z.string().optional())),
    option(name("subject"), cli(["--subject", "--sub"]), description("sub claim"), schema(z.string().optional())),
    option(name("audience"), cli(["--audience", "--aud"]), description("aud claim"), schema(z.string().optional())),
    option(name("jwtId"), cli(["--jwt-id", "--jti"]), description("jti claim"), schema(z.string().optional())),
    option(name("kid"), description("Key ID header (kid)"), schema(z.string().optional())),
    toggle(name("noIssuedAt"), description("Do not set an iat claim automatically")),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      checkStdin({
        secretStdin: model.secretStdin,
        payloadStdin: model.payloadStdin,
      });
      if (model.expiresIn !== undefined) parseDuration(model.expiresIn);

      const source = secretSource({
        ...(model.secretEnv === undefined ? {} : { secretEnv: model.secretEnv }),
        ...(model.secretFile === undefined ? {} : { secretFile: model.secretFile }),
        secretStdin: model.secretStdin,
      });
      const secret = await readSecret(source, { env: context.env, cwd: context.cwd });
      const payload = await readPayload(
        {
          ...(model.payload === undefined ? {} : { payload: model.payload }),
          ...(model.payloadFile === undefined ? {} : { payloadFile: model.payloadFile }),
          payloadStdin: model.payloadStdin,
        },
        context,
      );

      const token = await signJwt({
        algorithm: model.alg,
        secret,
        payload,
        ...(model.kid === undefined ? {} : { extraHeaders: { kid: model.kid } }),
        ...(model.expiresIn === undefined ? {} : { expiresIn: model.expiresIn }),
        ...(model.issuer === undefined ? {} : { issuer: model.issuer }),
        ...(model.subject === undefined ? {} : { subject: model.subject }),
        ...(model.audience === undefined ? {} : { audience: model.audience }),
        ...(model.jwtId === undefined ? {} : { jwtId: model.jwtId }),
        issuedAt: !model.noIssuedAt,
      });

      if (model.json) {
        const decoded = decodeToken(token);
        context.stdout.write(
          json({
            command: "jwt sign",
            algorithm: model.alg,
            token,
            header: decoded.header,
            payload: decoded.payload,
          }),
        );
      } else {
        context.stdout.write(`${token}\n`);
      }
      return 0;
    },
  },
);

import { description, name, route } from "@bomb.sh/router";

import { decode } from "./decode.ts";
import { sign } from "./sign.ts";
import { verify } from "./verify.ts";

/** JWT utilities. Decoding is separate from verification, and secrets never come from argv. */
export const jwt = route(
  name("jwt"),
  description("Decode, sign and verify JSON Web Tokens"),
  decode,
  sign,
  verify,
);

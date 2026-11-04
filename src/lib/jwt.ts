/**
 * Local JWT decode/sign/verify helpers.
 *
 * Decoding is explicitly not verification. Verification always receives an
 * explicit algorithm from the caller; the token's own `alg` header is never
 * trusted to choose a key type.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  decodeJwt,
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
  type JWTHeaderParameters,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";

export const JWT_ALGORITHMS = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export function isJwtAlgorithm(value: string): value is JwtAlgorithm {
  return (JWT_ALGORITHMS as readonly string[]).includes(value);
}

export function isSymmetricAlgorithm(algorithm: JwtAlgorithm): boolean {
  return algorithm.startsWith("HS");
}

export interface DecodedToken {
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: JWTPayload;
  readonly signature: string;
  readonly segments: number;
}

export function decodeToken(token: string): DecodedToken {
  const segments = token.split(".").length;
  if (segments !== 3) {
    throw new Error(`A JWT must have three dot-separated segments, got ${segments}`);
  }
  const header = decodeProtectedHeader(token) as Readonly<Record<string, unknown>>;
  const payload = decodeJwt(token);
  return { header, payload, signature: token.split(".")[2] ?? "", segments };
}

export interface ClaimState {
  readonly expiresAt?: number;
  readonly issuedAt?: number;
  readonly notBefore?: number;
  readonly expired: boolean;
  readonly notYetValid: boolean;
  readonly secondsRemaining?: number;
}

export function claimState(payload: JWTPayload, now = Math.floor(Date.now() / 1000)): ClaimState {
  const exp = typeof payload.exp === "number" ? payload.exp : undefined;
  const iat = typeof payload.iat === "number" ? payload.iat : undefined;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : undefined;
  return {
    ...(exp === undefined ? {} : { expiresAt: exp }),
    ...(iat === undefined ? {} : { issuedAt: iat }),
    ...(nbf === undefined ? {} : { notBefore: nbf }),
    expired: exp !== undefined && exp <= now,
    notYetValid: nbf !== undefined && nbf > now,
    ...(exp === undefined ? {} : { secondsRemaining: exp - now }),
  };
}

export type SecretSource =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };

export interface SecretOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

export async function readSecret(source: SecretSource, options: SecretOptions): Promise<string> {
  if (source.kind === "env") {
    const value = options.env[source.name];
    if (!value) throw new Error(`Environment variable ${source.name} is not set or is empty`);
    return value;
  }
  if (source.kind === "file") {
    const path = resolve(options.cwd, source.path);
    try {
      return (await readFile(path, "utf8")).replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(
        `Cannot read secret file ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const text = await Bun.stdin.text();
  if (!text.trim()) throw new Error("No secret was provided on stdin");
  return text.replace(/\r?\n$/, "");
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid duration ${JSON.stringify(value)}; use e.g. 30s, 15m, 1h, 7d`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier =
    unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 604800;
  return Math.round(amount * multiplier);
}

async function signingKey(algorithm: JwtAlgorithm, secret: string): Promise<CryptoKey | Uint8Array> {
  if (isSymmetricAlgorithm(algorithm)) {
    if (secret.length < 16) {
      throw new Error(`HMAC secrets should be at least 16 characters; got ${secret.length}`);
    }
    return new TextEncoder().encode(secret);
  }
  try {
    return await importPKCS8(secret, algorithm);
  } catch (error) {
    throw new Error(
      `Cannot import the private key for ${algorithm}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Pass a PKCS#8 PEM key via --secret-file or --secret-env.",
      { cause: error },
    );
  }
}

async function verificationKey(algorithm: JwtAlgorithm, secret: string): Promise<CryptoKey | Uint8Array> {
  if (isSymmetricAlgorithm(algorithm)) return new TextEncoder().encode(secret);
  try {
    return await importSPKI(secret, algorithm);
  } catch (error) {
    throw new Error(
      `Cannot import the public key for ${algorithm}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Pass a SubjectPublicKeyInfo PEM key via --secret-file or --secret-env.",
      { cause: error },
    );
  }
}

export interface SignOptions {
  readonly algorithm: JwtAlgorithm;
  readonly secret: string;
  readonly payload: JWTPayload;
  readonly extraHeaders?: Readonly<Record<string, unknown>>;
  readonly expiresIn?: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly audience?: string;
  readonly jwtId?: string;
  readonly issuedAt?: boolean;
}

export async function signJwt(options: SignOptions): Promise<string> {
  const key = await signingKey(options.algorithm, options.secret);
  const headers = { alg: options.algorithm, ...(options.extraHeaders ?? {}) } as JWTHeaderParameters;
  let token = new SignJWT(options.payload).setProtectedHeader(headers);
  if (options.issuedAt !== false) token = token.setIssuedAt();
  if (options.expiresIn) token = token.setExpirationTime(options.expiresIn);
  if (options.issuer) token = token.setIssuer(options.issuer);
  if (options.subject) token = token.setSubject(options.subject);
  if (options.audience) token = token.setAudience(options.audience);
  if (options.jwtId) token = token.setJti(options.jwtId);
  return token.sign(key);
}

export interface VerifyOptions {
  readonly algorithm: JwtAlgorithm;
  readonly secret: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly clockTolerance?: number;
}

export interface VerifyResult {
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: JWTPayload;
}

export async function verifyJwt(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const key = await verificationKey(options.algorithm, options.secret);
  const result = await jwtVerify(token, key, {
    algorithms: [options.algorithm],
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.clockTolerance === undefined ? {} : { clockTolerance: options.clockTolerance }),
  });
  return {
    header: result.protectedHeader as Readonly<Record<string, unknown>>,
    payload: result.payload,
  };
}

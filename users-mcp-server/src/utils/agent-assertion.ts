/**
 * Shared private_key_jwt client-assertion signing, used by every O4AA
 * token-exchange and A2A ID-JAG hop this server performs. Callers pass their
 * own clientId/privateKeyPath, so multiple agent identities (Agent A, Agent
 * B, ...) can each sign with their own key - only the resulting `aud`/exchange
 * shape differs per call site.
 *
 * NOTE: config is read from process.env lazily (inside functions, not as
 * module-level consts) - ESM hoists all `import` statements above other
 * top-level code, so a module-level `const X = process.env.X` evaluated
 * during the import phase would run before http-server.ts's own
 * `dotenv.config()` call has had a chance to populate process.env.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AgentJwk {
  kid: string;
  [key: string]: unknown;
}

// Keyed by privateKeyPath so multiple agent identities (Agent A, Agent B, ...)
// can each have their key loaded once and reused, rather than assuming a
// single agent per process.
const agentPrivateKeyCache = new Map<string, AgentJwk>();

function loadAgentPrivateKey(privateKeyPath: string): AgentJwk {
  const cached = agentPrivateKeyCache.get(privateKeyPath);
  if (cached) return cached;

  try {
    // Resolve relative to this project's root (two levels up from dist/utils
    // or src/utils), matching how the webapp resolves AGENT_PRIVATE_KEY_PATH
    // relative to its own __dirname.
    const keyPath = join(__dirname, '..', '..', privateKeyPath);
    const jwk = JSON.parse(readFileSync(keyPath, 'utf-8')) as AgentJwk;
    agentPrivateKeyCache.set(privateKeyPath, jwk);
    logger.info('Agent private key loaded successfully', { path: privateKeyPath });
    return jwk;
  } catch (err: any) {
    throw new Error(`Failed to load agent private key from ${privateKeyPath}: ${err.message}`);
  }
}

function jwkToPem(jwk: AgentJwk): string {
  const keyObject = crypto.createPrivateKey({ key: jwk as any, format: 'jwk' });
  return keyObject.export({ type: 'pkcs8', format: 'pem' }) as string;
}

export function generateClientAssertion(clientId: string, audience: string, privateKeyPath: string): string {
  const jwk = loadAgentPrivateKey(privateKeyPath);
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    iat: now,
    exp: now + 300, // 5 minutes
    jti: crypto.randomUUID(),
  };

  const privateKeyPem = jwkToPem(jwk);

  return jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    header: {
      alg: 'RS256',
      kid: jwk.kid,
    },
  });
}

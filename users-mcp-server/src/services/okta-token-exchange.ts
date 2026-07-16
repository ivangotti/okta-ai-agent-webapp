/**
 * O4AA vaulted-secret token exchange.
 *
 * The agent authenticates itself to Okta with private_key_jwt (the same
 * client_assertion pattern the webapp uses for its ID-JAG exchange), then
 * exchanges the calling user's raw ID token for a vaulted secret - the
 * live Okta API token (SSWS) stored in the PAM-managed connection
 * identified by VAULTED_SECRET_RESOURCE_ORN.
 *
 * This is intentionally NOT cached: a fresh vaulted secret is fetched for
 * every tool call.
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
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AgentJwk {
  kid: string;
  [key: string]: unknown;
}

let agentPrivateKey: AgentJwk | undefined;

function loadAgentPrivateKey(privateKeyPath: string): AgentJwk {
  if (agentPrivateKey) return agentPrivateKey;

  try {
    // Resolve relative to this project's root (two levels up from dist/services
    // or src/services), matching how the webapp resolves AGENT_PRIVATE_KEY_PATH
    // relative to its own __dirname.
    const keyPath = join(__dirname, '..', '..', privateKeyPath);
    agentPrivateKey = JSON.parse(readFileSync(keyPath, 'utf-8'));
    logger.info('Agent private key loaded successfully', { path: privateKeyPath });
    return agentPrivateKey as AgentJwk;
  } catch (err: any) {
    throw new Error(`Failed to load agent private key from ${privateKeyPath}: ${err.message}`);
  }
}

function jwkToPem(jwk: AgentJwk): string {
  const keyObject = crypto.createPrivateKey({ key: jwk as any, format: 'jwk' });
  return keyObject.export({ type: 'pkcs8', format: 'pem' }) as string;
}

function generateClientAssertion(clientId: string, tokenEndpoint: string, privateKeyPath: string): string {
  const jwk = loadAgentPrivateKey(privateKeyPath);
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenEndpoint,
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

interface VaultedSecretResponse {
  token_type?: string;
  issued_token_type?: string;
  expires_in?: number;
  vaulted_secret?: {
    // The field actually populated depends on the PAM connection's secret
    // type. `private` matches the generic O4AA spec; this org's API-key
    // connection returns `apikey` instead (confirmed against a live
    // exchange) - `password` is included as a further fallback for
    // username/password-style connections.
    private?: string;
    apikey?: string;
    password?: string;
  };
  error?: string;
  error_description?: string;
}

const SECRET_FIELDS = ['private', 'apikey', 'password'] as const;

/**
 * Deep-clones Okta's raw token-exchange response with just the secret
 * value swapped for "REDACTED" - everything else (issued_token_type,
 * expires_in, which field the secret came back under, ...) is preserved
 * verbatim so the shape shown in the webapp's viewer matches exactly what
 * Okta actually returned.
 */
function redactVaultedSecretResponse(data: VaultedSecretResponse): VaultedSecretResponse {
  const redacted: VaultedSecretResponse = JSON.parse(JSON.stringify(data));
  if (redacted.vaulted_secret) {
    for (const field of SECRET_FIELDS) {
      if (redacted.vaulted_secret[field] != null) {
        redacted.vaulted_secret[field] = 'REDACTED';
      }
    }
  }
  return redacted;
}

/**
 * Metadata about a vaulted-secret exchange, for surfacing in the webapp's
 * "OAuth Token Architecture" viewer. rawResponseRedacted mirrors Okta's
 * actual response shape (issued_token_type, vaulted_secret, ...) with only
 * the secret value itself swapped for "REDACTED" - never the real value.
 */
export interface VaultedSecretExchangeMeta {
  tokenEndpoint: string;
  resource: string;
  requestedTokenType: string;
  issuedTokenType?: string;
  subjectTokenType: string;
  expiresIn?: number;
  clientAssertion: string;
  fetchedAt: string;
  rawResponseRedacted: VaultedSecretResponse;
}

export interface VaultedSecretResult {
  secret: string;
  meta: VaultedSecretExchangeMeta;
}

// In-memory only, overwritten by the next exchange and cleared on process
// restart - never persisted. Exists solely so the webapp's red "DEBUG"
// button can reveal the real value of the most recent exchange for local
// debugging; the secret itself is still never included in any tool result
// or in VaultedSecretExchangeMeta above.
let lastRevealableSecret: { secret: string; fetchedAt: string } | null = null;

export function getLastRevealableSecret(): { secret: string; fetchedAt: string } | null {
  return lastRevealableSecret;
}

/**
 * Exchange the user's raw ID token for the vaulted secret (Okta API token)
 * stored behind VAULTED_SECRET_RESOURCE_ORN. Fetched fresh on every call.
 */
export async function getVaultedSecret(userIdToken: string): Promise<VaultedSecretResult> {
  const oktaDomain = process.env.OKTA_DOMAIN || 'https://blackcastle.oktapreview.com';
  const agentClientId = process.env.AGENT_CLIENT_ID;
  const agentPrivateKeyPath = process.env.AGENT_PRIVATE_KEY_PATH || '../agent-keys/agent-private-key.json';
  const resourceOrn = process.env.VAULTED_SECRET_RESOURCE_ORN;

  if (!agentClientId) {
    throw new Error('Missing required environment variable: AGENT_CLIENT_ID');
  }
  if (!resourceOrn) {
    throw new Error('Missing required environment variable: VAULTED_SECRET_RESOURCE_ORN');
  }

  const orgTokenEndpoint = `${oktaDomain}/oauth2/v1/token`;
  const clientAssertion = generateClientAssertion(agentClientId, orgTokenEndpoint, agentPrivateKeyPath);

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: userIdToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type: 'urn:okta:params:oauth:token-type:vaulted-secret',
    resource: resourceOrn,
    client_id: agentClientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
  });

  logger.info('Requesting vaulted secret', { endpoint: orgTokenEndpoint, resource: resourceOrn });
  // Verbose/debug-only: the exact wire request, unencoded and readable -
  // includes the real subject_token and client_assertion. Only visible
  // with LOG_LEVEL=debug on this server's own console, never sent to the
  // browser.
  logger.debug(
    `PAM vaulted-secret token exchange request (verbose)\n\n` +
      `POST ${orgTokenEndpoint}\n` +
      `Content-Type: application/x-www-form-urlencoded\n\n` +
      `grant_type=urn:ietf:params:oauth:grant-type:token-exchange\n` +
      `&subject_token=${userIdToken}\n` +
      `&subject_token_type=urn:ietf:params:oauth:token-type:id_token\n` +
      `&requested_token_type=urn:okta:params:oauth:token-type:vaulted-secret\n` +
      `&resource=${resourceOrn}\n` +
      `&client_id=${agentClientId}\n` +
      `&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer\n` +
      `&client_assertion=${clientAssertion}`
  );

  const response = await fetch(orgTokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const data = (await response.json().catch(() => ({}))) as VaultedSecretResponse;

  if (!response.ok) {
    const detail = data.error_description || data.error || (await response.text().catch(() => ''));
    throw new Error(`Vaulted secret exchange failed (${response.status}): ${detail}`);
  }

  const secret = data.vaulted_secret?.private || data.vaulted_secret?.apikey || data.vaulted_secret?.password;
  if (!secret) {
    throw new Error('Vaulted secret exchange succeeded but response contained no usable secret value (checked private/apikey/password)');
  }

  logger.info('Vaulted secret retrieved successfully', { issued_token_type: data.issued_token_type });
  // Verbose/debug-only: Okta validated the client_assertion against the
  // agent's registered public key, checked the resource connection, and
  // returned this - the real key, unredacted, for local debugging. Never
  // logged at info level, never sent to the browser except via the
  // explicit "DEBUG" reveal button.
  logger.debug(
    `PAM vaulted-secret token exchange response (verbose)\n\n${JSON.stringify(data, null, 2)}`
  );

  const fetchedAt = new Date().toISOString();
  lastRevealableSecret = { secret, fetchedAt };

  return {
    secret,
    meta: {
      tokenEndpoint: orgTokenEndpoint,
      resource: resourceOrn,
      requestedTokenType: 'urn:okta:params:oauth:token-type:vaulted-secret',
      issuedTokenType: data.issued_token_type,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
      expiresIn: data.expires_in,
      clientAssertion,
      fetchedAt,
      rawResponseRedacted: redactVaultedSecretResponse(data),
    },
  };
}

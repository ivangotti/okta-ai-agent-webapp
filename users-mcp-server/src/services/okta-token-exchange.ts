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

import { logger } from '../utils/logger.js';
import { generateClientAssertion } from '../utils/agent-assertion.js';

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

/**
 * Who signs the exchange and what's being exchanged. Both default to
 * today's single-hop behavior (Agent A signer, subject_token is a raw ID
 * token) so existing callers don't need to change. The A2A chain passes
 * Agent B's identity and the chained access token (T3) instead - see
 * search_users.ts / get_salesforce_service_account.ts.
 */
export interface PamExchangeOptions {
  subjectTokenType?: string;
  clientId?: string;
  privateKeyPath?: string;
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
 * Exchange a subject token for the vaulted secret (Okta API token) stored
 * behind VAULTED_SECRET_RESOURCE_ORN. Fetched fresh on every call.
 *
 * By default, subjectToken is treated as the caller's raw ID token and the
 * exchange is signed as Agent A (today's single-hop behavior). Pass
 * options.subjectTokenType='urn:ietf:params:oauth:token-type:access_token'
 * with options.clientId/privateKeyPath set to Agent B's identity to
 * exchange the A2A chain's access token (T3) instead - see
 * agent-a2a-chain.ts.
 */
export async function getVaultedSecret(subjectToken: string, options: PamExchangeOptions = {}): Promise<VaultedSecretResult> {
  const oktaDomain = process.env.OKTA_DOMAIN || 'https://blackcastle.oktapreview.com';
  const agentClientId = options.clientId || process.env.AGENT_CLIENT_ID;
  const agentPrivateKeyPath = options.privateKeyPath || process.env.AGENT_PRIVATE_KEY_PATH || '../agent-keys/agent-private-key.json';
  const subjectTokenType = options.subjectTokenType || 'urn:ietf:params:oauth:token-type:id_token';
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
    subject_token: subjectToken,
    subject_token_type: subjectTokenType,
    requested_token_type: 'urn:okta:params:oauth:token-type:vaulted-secret',
    resource: resourceOrn,
    client_id: agentClientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
  });

  logger.info('Requesting vaulted secret', { endpoint: orgTokenEndpoint, resource: resourceOrn, clientId: agentClientId, subjectTokenType });
  // Verbose/debug-only: the exact wire request, unencoded and readable -
  // includes the real subject_token and client_assertion. Only visible
  // with LOG_LEVEL=debug on this server's own console, never sent to the
  // browser.
  logger.debug(
    `PAM vaulted-secret token exchange request (verbose)\n\n` +
      `POST ${orgTokenEndpoint}\n` +
      `Content-Type: application/x-www-form-urlencoded\n\n` +
      `grant_type=urn:ietf:params:oauth:grant-type:token-exchange\n` +
      `&subject_token=${subjectToken}\n` +
      `&subject_token_type=${subjectTokenType}\n` +
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
      subjectTokenType,
      expiresIn: data.expires_in,
      clientAssertion,
      fetchedAt,
      rawResponseRedacted: redactVaultedSecretResponse(data),
    },
  };
}

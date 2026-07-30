/**
 * O4AA service-account token exchange.
 *
 * Same agent identity and client-assertion signing as the vaulted-secret
 * exchange (okta-token-exchange.ts), but a different Okta-namespaced
 * requested_token_type and a different resource ORN shape - this one
 * targets a PAM-managed app service account (Salesforce, here) rather than
 * an arbitrary vaulted secret.
 *
 * Response shape differs too: Okta returns `service_account: { username,
 * password }`, not a bearer token or API key - see
 * https://developer.okta.com/docs/guides/ai-agent-token-exchange/service-account/main.
 * Those credentials still need a second, non-Okta hop (Salesforce's own
 * OAuth login) before they're usable against the Salesforce API - see
 * salesforce-login.ts.
 *
 * This is intentionally NOT cached: fetched fresh for every tool call, same
 * as the vaulted-secret exchange.
 */

import { logger } from '../utils/logger.js';
import { generateClientAssertion } from '../utils/agent-assertion.js';

interface ServiceAccountTokenResponse {
  issued_token_type?: string;
  token_type?: string;
  expires_in?: number;
  service_account?: {
    username?: string;
    password?: string;
  };
  error?: string;
  error_description?: string;
}

/**
 * Metadata about a service-account exchange, for logging/inspection.
 * rawResponseRedacted mirrors Okta's actual response shape verbatim, with
 * only `service_account.password` swapped for "REDACTED" - username is not
 * secret and is kept visible.
 */
export interface ServiceAccountExchangeMeta {
  tokenEndpoint: string;
  resource: string;
  requestedTokenType: string;
  issuedTokenType?: string;
  subjectTokenType: string;
  expiresIn?: number;
  clientAssertion: string;
  fetchedAt: string;
  rawResponseRedacted: ServiceAccountTokenResponse;
}

export interface ServiceAccountCredentialResult {
  username: string;
  password: string;
  meta: ServiceAccountExchangeMeta;
}

/**
 * Who signs the exchange and what's being exchanged. Both default to
 * today's single-hop behavior (Agent A signer, subject_token is a raw ID
 * token) so existing callers don't need to change. The A2A chain passes
 * Agent B's identity and the chained access token (T3) instead - see
 * agent-a2a-chain.ts.
 */
export interface PamExchangeOptions {
  subjectTokenType?: string;
  clientId?: string;
  privateKeyPath?: string;
}

function redactServiceAccountResponse(data: ServiceAccountTokenResponse): ServiceAccountTokenResponse {
  const redacted: ServiceAccountTokenResponse = JSON.parse(JSON.stringify(data));
  if (redacted.service_account?.password != null) {
    redacted.service_account.password = 'REDACTED';
  }
  return redacted;
}

// In-memory only, overwritten by the next exchange and cleared on process
// restart - never persisted. Mirrors getLastRevealableSecret's debug-reveal
// pattern for the vaulted-secret flow.
let lastRevealableServiceAccount: { username: string; password: string; fetchedAt: string } | null = null;

export function getLastRevealableServiceAccount(): { username: string; password: string; fetchedAt: string } | null {
  return lastRevealableServiceAccount;
}

/**
 * Exchange a subject token for the Salesforce service-account credential
 * (username/password) vaulted behind SERVICE_ACCOUNT_RESOURCE_ORN. Fetched
 * fresh on every call.
 *
 * By default, subjectToken is treated as the caller's raw ID token and the
 * exchange is signed as Agent A (today's single-hop behavior). Pass
 * options.subjectTokenType='urn:ietf:params:oauth:token-type:access_token'
 * with options.clientId/privateKeyPath set to Agent B's identity to
 * exchange the A2A chain's access token (T3) instead - see
 * agent-a2a-chain.ts.
 */
export async function getServiceAccountCredential(subjectToken: string, options: PamExchangeOptions = {}): Promise<ServiceAccountCredentialResult> {
  const oktaDomain = process.env.OKTA_DOMAIN || 'https://blackcastle.oktapreview.com';
  const agentClientId = options.clientId || process.env.AGENT_CLIENT_ID;
  const agentPrivateKeyPath = options.privateKeyPath || process.env.AGENT_PRIVATE_KEY_PATH || '../agent-keys/agent-private-key.json';
  const subjectTokenType = options.subjectTokenType || 'urn:ietf:params:oauth:token-type:id_token';
  const resourceOrn = process.env.SERVICE_ACCOUNT_RESOURCE_ORN;

  if (!agentClientId) {
    throw new Error('Missing required environment variable: AGENT_CLIENT_ID');
  }
  if (!resourceOrn) {
    throw new Error('Missing required environment variable: SERVICE_ACCOUNT_RESOURCE_ORN');
  }

  const orgTokenEndpoint = `${oktaDomain}/oauth2/v1/token`;
  const clientAssertion = generateClientAssertion(agentClientId, orgTokenEndpoint, agentPrivateKeyPath);

  const requestedTokenType = 'urn:okta:params:oauth:token-type:service-account';

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: subjectToken,
    subject_token_type: subjectTokenType,
    requested_token_type: requestedTokenType,
    resource: resourceOrn,
    client_id: agentClientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
  });

  logger.info('Requesting service-account credential', { endpoint: orgTokenEndpoint, resource: resourceOrn, clientId: agentClientId, subjectTokenType });
  // Verbose/debug-only: the exact wire request, unencoded and readable -
  // includes the real subject_token and client_assertion. Only visible with
  // LOG_LEVEL=debug on this server's own console, never sent to the browser.
  logger.debug(
    `PAM service-account token exchange request (verbose)\n\n` +
      `POST ${orgTokenEndpoint}\n` +
      `Content-Type: application/x-www-form-urlencoded\n\n` +
      `grant_type=urn:ietf:params:oauth:grant-type:token-exchange\n` +
      `&subject_token=${subjectToken}\n` +
      `&subject_token_type=${subjectTokenType}\n` +
      `&requested_token_type=${requestedTokenType}\n` +
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

  const data = (await response.json().catch(() => ({}))) as ServiceAccountTokenResponse;

  if (!response.ok) {
    const detail = data.error_description || data.error || (await response.text().catch(() => ''));
    throw new Error(`Service-account exchange failed (${response.status}): ${detail}`);
  }

  const username = data.service_account?.username;
  const password = data.service_account?.password;
  if (!username || !password) {
    throw new Error('Service-account exchange succeeded but response contained no usable service_account.username/password');
  }

  logger.info('Service-account credential retrieved successfully', { issued_token_type: data.issued_token_type, username });
  // Verbose/debug-only: Okta validated the client_assertion against the
  // agent's registered public key, checked the Resource Connection, and
  // returned this - the real password, unredacted, for local debugging.
  // Never logged at info level, never sent to the browser except via the
  // explicit "DEBUG" reveal button.
  logger.debug(
    `PAM service-account token exchange response (verbose)\n\n${JSON.stringify(data, null, 2)}`
  );

  const fetchedAt = new Date().toISOString();
  lastRevealableServiceAccount = { username, password, fetchedAt };

  return {
    username,
    password,
    meta: {
      tokenEndpoint: orgTokenEndpoint,
      resource: resourceOrn,
      requestedTokenType,
      issuedTokenType: data.issued_token_type,
      subjectTokenType,
      expiresIn: data.expires_in,
      clientAssertion,
      fetchedAt,
      rawResponseRedacted: redactServiceAccountResponse(data),
    },
  };
}

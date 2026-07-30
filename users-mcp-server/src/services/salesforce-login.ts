/**
 * Optional second hop: exchange the Salesforce service-account
 * username/password (retrieved from Okta PAM via
 * okta-service-account-exchange.ts) for an actual Salesforce session, using
 * Salesforce's own OAuth 2.0 username-password grant.
 *
 * This is entirely separate from Okta - Salesforce doesn't accept the
 * vaulted username/password directly as an API credential, so this hop is
 * required before the credential is usable against the Salesforce API.
 *
 * Gated on SALESFORCE_CLIENT_ID/SALESFORCE_CLIENT_SECRET being configured
 * (a Salesforce Connected App). If either is missing, this returns null
 * without making a network call, rather than failing - the PAM retrieval
 * itself is the primary thing being demonstrated, and shouldn't fail just
 * because the downstream Salesforce login isn't set up yet.
 */

import { logger } from '../utils/logger.js';

export interface SalesforceSession {
  accessToken: string;
  instanceUrl: string;
}

interface SalesforceTokenResponse {
  access_token?: string;
  instance_url?: string;
  error?: string;
  error_description?: string;
}

export async function loginToSalesforce(username: string, password: string): Promise<SalesforceSession | null> {
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.info('Skipping Salesforce login: SALESFORCE_CLIENT_ID/SALESFORCE_CLIENT_SECRET not configured');
    return null;
  }

  const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const tokenEndpoint = `${loginUrl}/services/oauth2/token`;

  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
  });

  logger.info('Logging into Salesforce with the PAM-retrieved service account', { endpoint: tokenEndpoint, username });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const data = (await response.json().catch(() => ({}))) as SalesforceTokenResponse;

  if (!response.ok || !data.access_token || !data.instance_url) {
    const detail = data.error_description || data.error || (await response.text().catch(() => ''));
    throw new Error(`Salesforce login failed (${response.status}): ${detail}`);
  }

  logger.info('Salesforce login succeeded', { instanceUrl: data.instance_url });

  return {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
  };
}

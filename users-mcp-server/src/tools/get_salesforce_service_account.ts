import { z } from 'zod';
import { getServiceAccountCredential, ServiceAccountExchangeMeta } from '../services/okta-service-account-exchange.js';
import { getAgentBChainedAccessToken, AgentA2AChainMeta } from '../services/agent-a2a-chain.js';
import { loginToSalesforce } from '../services/salesforce-login.js';
import { logger } from '../utils/logger.js';

export const GetSalesforceServiceAccountSchema = z.object({});

export type GetSalesforceServiceAccountParams = z.infer<typeof GetSalesforceServiceAccountSchema>;

export interface SalesforceLoginOutcome {
  attempted: boolean;
  loggedIn: boolean;
  instanceUrl?: string;
  skippedReason?: string;
}

export interface GetSalesforceServiceAccountResult {
  success: boolean;
  username?: string;
  salesforceLogin?: SalesforceLoginOutcome;
  error?: string;
  // Metadata about the two-hop A2A delegation chain (Agent A -> Agent B)
  // that ran before the PAM exchange below - never a raw token, just
  // decoded claims proving the chain of custody. See agent-a2a-chain.ts.
  a2aChain?: AgentA2AChainMeta;
  // Metadata about the PAM service-account exchange this call performed -
  // never the password. Same convention as search_users's pamExchange.
  pamExchange?: ServiceAccountExchangeMeta;
}

/**
 * Tool handler for get-salesforce-service-account.
 *
 * userIdToken is the raw Okta ID token of the person chatting with the
 * webapp. It is first delegated through the A2A chain (Agent A -> Agent B,
 * see agent-a2a-chain.ts); the resulting chained access token (T3) is then
 * used as the subject_token for the service-account exchange, signed with
 * Agent B's identity - so the credential is ultimately retrieved by Agent B,
 * with Agent A recorded as the actor in T3's `act` claim.
 */
export async function getSalesforceServiceAccount(
  _params: GetSalesforceServiceAccountParams,
  userIdToken: string
): Promise<GetSalesforceServiceAccountResult> {
  try {
    const { accessToken: chainedAccessToken, meta: a2aChain } = await getAgentBChainedAccessToken(userIdToken);

    const { username, password, meta: pamExchange } = await getServiceAccountCredential(chainedAccessToken, {
      subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      clientId: process.env.AGENT_B_CLIENT_ID,
      privateKeyPath: process.env.AGENT_B_PRIVATE_KEY_PATH,
    });

    let salesforceLogin: SalesforceLoginOutcome;
    try {
      const session = await loginToSalesforce(username, password);
      salesforceLogin = session
        ? { attempted: true, loggedIn: true, instanceUrl: session.instanceUrl }
        : { attempted: true, loggedIn: false, skippedReason: 'SALESFORCE_CLIENT_ID/SALESFORCE_CLIENT_SECRET not configured' };
    } catch (loginError: any) {
      // The PAM retrieval itself succeeded - a downstream Salesforce login
      // failure doesn't invalidate that, so this doesn't fail the whole call.
      salesforceLogin = { attempted: true, loggedIn: false, skippedReason: loginError.message };
    }

    return {
      success: true,
      username,
      salesforceLogin,
      a2aChain,
      pamExchange,
    };
  } catch (error: any) {
    logger.error('get_salesforce_service_account tool failed', { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

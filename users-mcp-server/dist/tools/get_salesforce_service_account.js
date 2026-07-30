import { z } from 'zod';
import { getServiceAccountCredential } from '../services/okta-service-account-exchange.js';
import { getAgentBChainedAccessToken } from '../services/agent-a2a-chain.js';
import { loginToSalesforce } from '../services/salesforce-login.js';
import { logger } from '../utils/logger.js';
export const GetSalesforceServiceAccountSchema = z.object({});
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
export async function getSalesforceServiceAccount(_params, userIdToken) {
    try {
        const { accessToken: chainedAccessToken, meta: a2aChain } = await getAgentBChainedAccessToken(userIdToken);
        const { username, password, meta: pamExchange } = await getServiceAccountCredential(chainedAccessToken, {
            subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token',
            clientId: process.env.AGENT_B_CLIENT_ID,
            privateKeyPath: process.env.AGENT_B_PRIVATE_KEY_PATH,
        });
        let salesforceLogin;
        try {
            const session = await loginToSalesforce(username, password);
            salesforceLogin = session
                ? { attempted: true, loggedIn: true, instanceUrl: session.instanceUrl }
                : { attempted: true, loggedIn: false, skippedReason: 'SALESFORCE_CLIENT_ID/SALESFORCE_CLIENT_SECRET not configured' };
        }
        catch (loginError) {
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
    }
    catch (error) {
        logger.error('get_salesforce_service_account tool failed', { error: error.message });
        return {
            success: false,
            error: error.message,
        };
    }
}

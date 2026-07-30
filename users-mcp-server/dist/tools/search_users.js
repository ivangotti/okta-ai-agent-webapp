import { z } from 'zod';
import { getVaultedSecret } from '../services/okta-token-exchange.js';
import { getAgentBChainedAccessToken } from '../services/agent-a2a-chain.js';
import { searchUsers as searchOktaUsers } from '../services/okta-users-api.js';
import { logger } from '../utils/logger.js';
export const SearchUsersSchema = z
    .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().optional(),
    limit: z.number().min(1).max(200).default(20),
})
    .refine((data) => Boolean(data.firstName || data.lastName || data.email), {
    message: 'At least one of firstName, lastName, or email must be provided',
});
/**
 * Tool handler for search-users.
 *
 * userIdToken is the raw Okta ID token of the person chatting with the
 * webapp. It is first delegated through the A2A chain (Agent A -> Agent B,
 * see agent-a2a-chain.ts); the resulting chained access token (T3) is then
 * used as the subject_token for the vaulted-secret exchange, signed with
 * Agent B's identity - so the secret is ultimately retrieved by Agent B,
 * with Agent A recorded as the actor in T3's `act` claim.
 */
export async function searchUsers(params, userIdToken) {
    try {
        const { accessToken: chainedAccessToken, meta: a2aChain } = await getAgentBChainedAccessToken(userIdToken);
        const { secret: apiToken, meta: pamExchange } = await getVaultedSecret(chainedAccessToken, {
            subjectTokenType: 'urn:ietf:params:oauth:token-type:access_token',
            clientId: process.env.AGENT_B_CLIENT_ID,
            privateKeyPath: process.env.AGENT_B_PRIVATE_KEY_PATH,
        });
        const users = await searchOktaUsers(apiToken, params);
        return {
            success: true,
            count: users.length,
            users,
            a2aChain,
            pamExchange,
        };
    }
    catch (error) {
        logger.error('search_users tool failed', { error: error.message });
        return {
            success: false,
            error: error.message,
        };
    }
}

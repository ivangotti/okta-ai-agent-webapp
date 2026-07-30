import { z } from 'zod';
import { getVaultedSecret, VaultedSecretExchangeMeta } from '../services/okta-token-exchange.js';
import { getAgentBChainedAccessToken, AgentA2AChainMeta } from '../services/agent-a2a-chain.js';
import { searchUsers as searchOktaUsers, OktaUserSummary } from '../services/okta-users-api.js';
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

export type SearchUsersParams = z.infer<typeof SearchUsersSchema>;

export interface SearchUsersResult {
  success: boolean;
  count?: number;
  users?: OktaUserSummary[];
  error?: string;
  // Metadata about the two-hop A2A delegation chain (Agent A -> Agent B)
  // that ran before the PAM exchange below - never a raw token, just
  // decoded claims proving the chain of custody. See agent-a2a-chain.ts.
  a2aChain?: AgentA2AChainMeta;
  // Metadata about the PAM vaulted-secret exchange this call performed -
  // never the secret value itself. Surfaced by the webapp in its "OAuth
  // Token Architecture" viewer so the diagram reflects the real flow that
  // just ran instead of only the ID-JAG one.
  pamExchange?: VaultedSecretExchangeMeta;
}

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
export async function searchUsers(params: SearchUsersParams, userIdToken: string): Promise<SearchUsersResult> {
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
  } catch (error: any) {
    logger.error('search_users tool failed', { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

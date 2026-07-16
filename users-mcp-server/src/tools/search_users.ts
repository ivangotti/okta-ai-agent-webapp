import { z } from 'zod';
import { getVaultedSecret } from '../services/okta-token-exchange.js';
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
}

/**
 * Tool handler for search-users.
 *
 * userIdToken is the raw Okta ID token of the person chatting with the
 * webapp - it is used as the subject_token for the vaulted-secret
 * exchange, fetched fresh for this call (no caching).
 */
export async function searchUsers(params: SearchUsersParams, userIdToken: string): Promise<SearchUsersResult> {
  try {
    const apiToken = await getVaultedSecret(userIdToken);
    const users = await searchOktaUsers(apiToken, params);

    return {
      success: true,
      count: users.length,
      users,
    };
  } catch (error: any) {
    logger.error('search_users tool failed', { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

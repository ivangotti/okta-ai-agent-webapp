/**
 * Thin wrapper around Okta's List Users API
 * (https://developer.okta.com/docs/api/openapi/okta-management/management/tags/user/other/listusers)
 */
import { logger } from '../utils/logger.js';
function escapeFilterValue(value) {
    return value.replace(/"/g, '\\"');
}
function buildSearchExpression(params) {
    const clauses = [];
    if (params.email) {
        clauses.push(`profile.email eq "${escapeFilterValue(params.email)}"`);
    }
    if (params.firstName) {
        clauses.push(`profile.firstName eq "${escapeFilterValue(params.firstName)}"`);
    }
    if (params.lastName) {
        clauses.push(`profile.lastName eq "${escapeFilterValue(params.lastName)}"`);
    }
    return clauses.join(' and ');
}
/**
 * Search Okta users by first name, last name, and/or email.
 * At least one of firstName/lastName/email must be provided by the caller.
 */
export async function searchUsers(apiToken, params) {
    const searchExpr = buildSearchExpression(params);
    if (!searchExpr) {
        throw new Error('searchUsers requires at least one of firstName, lastName, or email');
    }
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const oktaDomain = process.env.OKTA_DOMAIN || 'https://blackcastle.oktapreview.com';
    const url = new URL('/api/v1/users', oktaDomain);
    url.searchParams.set('search', searchExpr);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('fields', 'id,status,profile:(firstName,lastName,email,login)');
    logger.info('Calling Okta Users API', { url: url.toString() });
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: `SSWS ${apiToken}`,
            'Content-Type': 'application/json; okta-response=omitCredentials,omitCredentialsLinks',
            Accept: 'application/json',
        },
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Okta Users API request failed (${response.status}): ${detail}`);
    }
    const users = (await response.json());
    return users.map((u) => ({
        id: u.id,
        status: u.status,
        firstName: u.profile?.firstName,
        lastName: u.profile?.lastName,
        email: u.profile?.email,
        login: u.profile?.login,
    }));
}

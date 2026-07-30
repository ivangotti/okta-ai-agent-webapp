/**
 * Agent-to-agent (A2A) two-hop ID-JAG delegation chain.
 *
 * Agent A (this server's primary identity, AGENT_CLIENT_ID) delegates to
 * Agent B (AGENT_B_CLIENT_ID) so that Agent B becomes the actor that
 * ultimately performs the PAM exchange in okta-token-exchange.ts /
 * okta-service-account-exchange.ts. This mirrors the canonical Okta A2A
 * pattern (token-exchange -> ID-JAG, then jwt-bearer redemption) with no
 * actor_token anywhere - the chain of custody lives entirely in the `act`
 * claim Okta stamps into the resulting access token.
 *
 *   Hop 1        Agent A trades the caller's raw ID token for an ID-JAG
 *                scoped to Agent B, signed with Agent A's key.
 *   Hop 1 redeem Agent A redeems that ID-JAG at Agent B's Custom AS via
 *                jwt-bearer (still signed with Agent A's key - the
 *                redeeming party authenticates as Agent A). The resulting
 *                access token ("T3") is what Agent B receives; its `act`
 *                claim names Agent A.
 *
 * T3 is then handed to okta-token-exchange.ts / okta-service-account-
 * exchange.ts as the subject_token for the actual PAM exchange, signed with
 * Agent B's own key - see search_users.ts / get_salesforce_service_account.ts.
 *
 * NOTE: config is read from process.env lazily (inside functions, not as
 * module-level consts) - see agent-assertion.ts for why.
 */
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';
import { generateClientAssertion } from '../utils/agent-assertion.js';
// In-memory only, overwritten by the next chain run and cleared on process
// restart - never persisted. Exists solely so the webapp's debug tooling can
// reveal the real ID-JAG / access token strings for local debugging; normal
// tool results only ever carry the decoded claims in AgentA2AChainMeta above.
let lastRevealableChainTokens = null;
export function getLastRevealableA2AChain() {
    return lastRevealableChainTokens;
}
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
/**
 * Runs the full Agent A -> Agent B ID-JAG chain and returns the resulting
 * access token (T3), signed for Agent B. Fetched fresh on every call - no
 * caching, same convention as the PAM exchanges downstream of this.
 */
export async function getAgentBChainedAccessToken(userIdToken) {
    const oktaDomain = process.env.OKTA_DOMAIN || 'https://blackcastle.oktapreview.com';
    const agentAClientId = requireEnv('AGENT_CLIENT_ID');
    const agentAPrivateKeyPath = process.env.AGENT_PRIVATE_KEY_PATH || '../agent-keys/agent-private-key.json';
    const agentBClientId = requireEnv('AGENT_B_CLIENT_ID');
    const agentBResourceUrl = requireEnv('AGENT_B_RESOURCE_URL');
    const agentBAuthServerId = requireEnv('AGENT_B_AUTH_SERVER_ID');
    const scope = process.env.AGENT_B_SCOPE || 'agent.invoke';
    const orgTokenEndpoint = `${oktaDomain}/oauth2/v1/token`;
    const agentBAuthServerBase = `${oktaDomain}/oauth2/${agentBAuthServerId}`;
    const agentBTokenEndpoint = `${agentBAuthServerBase}/v1/token`;
    // --- Hop 1: Agent A trades the caller's ID token for an ID-JAG scoped to Agent B ---
    const hop1Assertion = generateClientAssertion(agentAClientId, orgTokenEndpoint, agentAPrivateKeyPath);
    const hop1Params = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: userIdToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        audience: agentBAuthServerBase,
        resource: agentBResourceUrl,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: hop1Assertion,
        scope,
    });
    logger.info('A2A hop 1: requesting ID-JAG for Agent B', { endpoint: orgTokenEndpoint, audience: agentBAuthServerBase, resource: agentBResourceUrl });
    logger.debug(`A2A hop 1 request (verbose)\n\nPOST ${orgTokenEndpoint}\n${hop1Params.toString()}`);
    const hop1Response = await fetch(orgTokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: hop1Params.toString(),
    });
    const hop1Data = (await hop1Response.json().catch(() => ({})));
    if (!hop1Response.ok || !hop1Data.access_token) {
        const detail = hop1Data.error_description || hop1Data.error || (await hop1Response.text().catch(() => ''));
        throw new Error(`A2A hop 1 (ID-JAG for Agent B) failed (${hop1Response.status}): ${detail}`);
    }
    const idJag = hop1Data.access_token;
    const idJagClaims = jwt.decode(idJag) || {};
    logger.debug(`A2A hop 1 response (verbose)\n\n${JSON.stringify(hop1Data, null, 2)}`);
    // --- Hop 1 redeem: Agent A redeems the ID-JAG at Agent B's Custom AS (jwt-bearer) ---
    const hop1RedeemAssertion = generateClientAssertion(agentAClientId, agentBTokenEndpoint, agentAPrivateKeyPath);
    // Deliberately NO `scope` param here - scope is inherited from the ID-JAG,
    // same caveat this codebase's README already documents for the MCP flow.
    const hop1RedeemParams = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: idJag,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: hop1RedeemAssertion,
    });
    logger.info('A2A hop 1 redeem: exchanging ID-JAG for access token at Agent B Custom AS', { endpoint: agentBTokenEndpoint });
    logger.debug(`A2A hop 1 redeem request (verbose)\n\nPOST ${agentBTokenEndpoint}\n${hop1RedeemParams.toString()}`);
    const hop1RedeemResponse = await fetch(agentBTokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: hop1RedeemParams.toString(),
    });
    const hop1RedeemData = (await hop1RedeemResponse.json().catch(() => ({})));
    if (!hop1RedeemResponse.ok || !hop1RedeemData.access_token) {
        const detail = hop1RedeemData.error_description || hop1RedeemData.error || (await hop1RedeemResponse.text().catch(() => ''));
        throw new Error(`A2A hop 1 redeem (access token for Agent B) failed (${hop1RedeemResponse.status}): ${detail}`);
    }
    const chainedAccessToken = hop1RedeemData.access_token;
    logger.debug(`A2A hop 1 redeem response (verbose)\n\n${JSON.stringify(hop1RedeemData, null, 2)}`);
    const decoded = jwt.decode(chainedAccessToken) || {};
    logger.info('A2A chain complete', { sub: decoded.sub, act: decoded.act, expiresIn: hop1RedeemData.expires_in });
    const fetchedAt = new Date().toISOString();
    lastRevealableChainTokens = { idJag, accessToken: chainedAccessToken, fetchedAt };
    return {
        accessToken: chainedAccessToken,
        meta: {
            agentAClientId,
            agentBClientId,
            hop1: {
                tokenEndpoint: orgTokenEndpoint,
                audience: agentBAuthServerBase,
                resource: agentBResourceUrl,
                scope,
                issuedTokenType: hop1Data.issued_token_type,
                expiresIn: hop1Data.expires_in,
                clientAssertion: hop1Assertion,
                idJag,
                idJagClaims,
            },
            hop1Redeem: {
                tokenEndpoint: agentBTokenEndpoint,
                issuedTokenType: hop1RedeemData.issued_token_type,
                expiresIn: hop1RedeemData.expires_in,
                clientAssertion: hop1RedeemAssertion,
            },
            chainedAccessToken,
            chainedAccessTokenClaims: decoded,
            fetchedAt,
        },
    };
}

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
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
let agentPrivateKey;
function loadAgentPrivateKey(privateKeyPath) {
    if (agentPrivateKey)
        return agentPrivateKey;
    try {
        // Resolve relative to this project's root (two levels up from dist/services
        // or src/services), matching how the webapp resolves AGENT_PRIVATE_KEY_PATH
        // relative to its own __dirname.
        const keyPath = join(__dirname, '..', '..', privateKeyPath);
        agentPrivateKey = JSON.parse(readFileSync(keyPath, 'utf-8'));
        logger.info('Agent private key loaded successfully', { path: privateKeyPath });
        return agentPrivateKey;
    }
    catch (err) {
        throw new Error(`Failed to load agent private key from ${privateKeyPath}: ${err.message}`);
    }
}
function jwkToPem(jwk) {
    const keyObject = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    return keyObject.export({ type: 'pkcs8', format: 'pem' });
}
function generateClientAssertion(clientId, tokenEndpoint, privateKeyPath) {
    const jwk = loadAgentPrivateKey(privateKeyPath);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: clientId,
        sub: clientId,
        aud: tokenEndpoint,
        iat: now,
        exp: now + 300, // 5 minutes
        jti: crypto.randomUUID(),
    };
    const privateKeyPem = jwkToPem(jwk);
    return jwt.sign(payload, privateKeyPem, {
        algorithm: 'RS256',
        header: {
            alg: 'RS256',
            kid: jwk.kid,
        },
    });
}
/**
 * Exchange the user's raw ID token for the vaulted secret (Okta API token)
 * stored behind VAULTED_SECRET_RESOURCE_ORN. Fetched fresh on every call.
 */
export async function getVaultedSecret(userIdToken) {
    const oktaDomain = process.env.OKTA_DOMAIN || 'https://blackcastle.oktapreview.com';
    const agentClientId = process.env.AGENT_CLIENT_ID;
    const agentPrivateKeyPath = process.env.AGENT_PRIVATE_KEY_PATH || '../agent-keys/agent-private-key.json';
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
        subject_token: userIdToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:okta:params:oauth:token-type:vaulted-secret',
        resource: resourceOrn,
        client_id: agentClientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: clientAssertion,
    });
    logger.info('Requesting vaulted secret', { endpoint: orgTokenEndpoint, resource: resourceOrn });
    const response = await fetch(orgTokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: params.toString(),
    });
    const data = (await response.json().catch(() => ({})));
    if (!response.ok) {
        const detail = data.error_description || data.error || (await response.text().catch(() => ''));
        throw new Error(`Vaulted secret exchange failed (${response.status}): ${detail}`);
    }
    const secret = data.vaulted_secret?.private || data.vaulted_secret?.apikey || data.vaulted_secret?.password;
    if (!secret) {
        throw new Error('Vaulted secret exchange succeeded but response contained no usable secret value (checked private/apikey/password)');
    }
    logger.info('Vaulted secret retrieved successfully', { issued_token_type: data.issued_token_type });
    return secret;
}

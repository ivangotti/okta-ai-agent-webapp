import express from 'express';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import { Strategy as OpenIDConnectStrategy } from 'passport-openidconnect';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

// ─── Token File Logger ───────────────────────────────────────────────────────
const LOG_DIR = join(__dirname, 'logs');
const TOKEN_LOG = join(LOG_DIR, 'tokens.log');
mkdirSync(LOG_DIR, { recursive: true });

function logToken(label, token, extra = {}) {
  const timestamp = new Date().toISOString();
  const decoded = typeof token === 'string' ? parseJwtSafe(token) : token;
  const entry = {
    timestamp,
    label,
    ...extra,
    raw: typeof token === 'string' ? token : undefined,
    decoded
  };
  const line = `\n${'═'.repeat(80)}\n` +
    `🔑 ${label}  |  ${timestamp}\n` +
    `${'─'.repeat(80)}\n` +
    (extra.user ? `   User: ${extra.user}\n` : '') +
    (extra.flow ? `   Flow: ${extra.flow}\n` : '') +
    (extra.endpoint ? `   Endpoint: ${extra.endpoint}\n` : '') +
    `${'─'.repeat(80)}\n` +
    `RAW:\n${typeof token === 'string' ? token : '(object)'}\n\n` +
    `DECODED:\n${JSON.stringify(decoded, null, 2)}\n` +
    `${'═'.repeat(80)}\n`;

  appendFileSync(TOKEN_LOG, line);
  console.log(`📝 Token logged → ${TOKEN_LOG} [${label}]`);
}

// Safe JWT parse (used before the main parseJwt is defined)
function parseJwtSafe(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { error: 'not a JWT', value: token.substring(0, 50) + '...' };
    const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return { header, payload };
  } catch (e) {
    return { error: 'parse failed', snippet: token.substring(0, 50) };
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

// Configuration from environment
let LITELLM_BASE_URL = process.env.ANTHROPIC_BASE_URL || null;
const LITELLM_SITE = process.env.LITELLM_SITE || null;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:8080';
const USERS_MCP_SERVER_URL = process.env.USERS_MCP_SERVER_URL || 'http://localhost:8081';

// Registry of all MCP servers this webapp talks to. Add an entry here when
// wiring in a new MCP server - the "MCP Server Status & Tools" UI and its
// backing endpoint (/api/mcp-servers) are both driven by this list.
const MCP_SERVERS = [
  { key: 'nist', name: 'NIST CSF 2.0 MCP Server', url: MCP_SERVER_URL },
  { key: 'users', name: 'Users MCP Server', url: USERS_MCP_SERVER_URL }
];

// ─── Okta Credential Manager (OCM) ───────────────────────────────────────────
// Shells out to `ocm auth litellm --format json`, caches the bundle,
// refreshes ~5 min before expiry, force-refreshes on 401.
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
let ocmTokenBundle = null;
let ocmTokenRefreshPromise = null;

async function fetchOcmLitellmToken({ site, force = false } = {}) {
  const args = ['auth', 'litellm', '--format', 'json'];
  if (site) args.push('--site', site);
  if (force) args.push('--force');

  let stdout;
  try {
    const result = await execFileAsync('ocm', args, {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024
    });
    stdout = result.stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('ocm CLI not found in PATH. Install Okta Credential Manager.');
    }
    const stderr = (err.stderr || '').trim();
    throw new Error(`ocm auth litellm failed: ${stderr || err.message}`);
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('ocm auth litellm returned non-JSON output');
  }
  if (!data.access_token) {
    throw new Error('ocm auth litellm response missing access_token');
  }
  const expiresAt = data.expires_in ? new Date(data.expires_in).getTime() : null;
  return {
    accessToken: data.access_token,
    tokenHost: data.token_host || null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
  };
}

async function getLiteLLMToken({ force = false } = {}) {
  const now = Date.now();
  const isFresh = ocmTokenBundle?.accessToken &&
    (!ocmTokenBundle.expiresAt || ocmTokenBundle.expiresAt - now > TOKEN_REFRESH_LEEWAY_MS);
  if (!force && isFresh) return ocmTokenBundle.accessToken;

  if (!ocmTokenRefreshPromise) {
    ocmTokenRefreshPromise = (async () => {
      console.log(`🔑 Refreshing LiteLLM token via ocm${LITELLM_SITE ? ` (--site ${LITELLM_SITE})` : ''}...`);
      const bundle = await fetchOcmLitellmToken({ site: LITELLM_SITE, force });
      ocmTokenBundle = bundle;
      // Derive base URL from token_host if not explicitly set.
      if (!LITELLM_BASE_URL && bundle.tokenHost) {
        LITELLM_BASE_URL = `https://${bundle.tokenHost}`;
        console.log(`🔑 Derived LITELLM_BASE_URL from ocm: ${LITELLM_BASE_URL}`);
      }
      if (bundle.expiresAt) {
        const minutes = Math.round((bundle.expiresAt - Date.now()) / 60000);
        console.log(`🔑 Token valid for ~${minutes} min`);
      }
      return bundle.accessToken;
    })().finally(() => { ocmTokenRefreshPromise = null; });
  }
  return ocmTokenRefreshPromise;
}

async function callLiteLLM(path, init) {
  let token = await getLiteLLMToken();
  if (!LITELLM_BASE_URL) LITELLM_BASE_URL = 'https://llm.atko.ai';
  const buildHeaders = (t) => ({
    ...init.headers,
    'Authorization': `Bearer ${t}`,
    'x-api-key': t
  });

  let response = await fetch(`${LITELLM_BASE_URL}${path}`, { ...init, headers: buildHeaders(token) });
  if (response.status === 401) {
    console.log('🔑 Got 401 from LiteLLM, forcing ocm token refresh');
    token = await getLiteLLMToken({ force: true });
    response = await fetch(`${LITELLM_BASE_URL}${path}`, { ...init, headers: buildHeaders(token) });
  }
  return response;
}
// ─────────────────────────────────────────────────────────────────────────────
const MODEL = process.env.MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-4-5-sonnet';

// Okta Configuration (User Authentication - Inbound) - FROM ENV
const OKTA_DOMAIN = process.env.OKTA_DOMAIN || 'https://blackcastle.oktapreview.com';
const OKTA_ISSUER = process.env.OKTA_ISSUER || 'https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8';
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID;
const OKTA_CLIENT_SECRET = process.env.OKTA_CLIENT_SECRET;
const OKTA_REDIRECT_URI = process.env.OKTA_REDIRECT_URI || 'http://localhost:3001/authorization-code/callback';
const OKTA_LOGOUT_REDIRECT_URI = process.env.OKTA_LOGOUT_REDIRECT_URI || 'http://localhost:3001';

// Okta ORG Token Endpoint (for Step 1 of ID-JAG)
const ORG_TOKEN_ENDPOINT = `${OKTA_DOMAIN}/oauth2/v1/token`;

// Custom Authorization Server (for Step 2 and audience) - FROM ENV
const CUSTOM_AUTH_SERVER = process.env.CUSTOM_AUTH_SERVER || 'https://blackcastle.oktapreview.com/oauth2/aus2o8ra5nfzluTlI0h8';
const MCP_AUDIENCE = process.env.MCP_AUDIENCE || 'api://nist-mcp-server';
const MCP_SCOPE = process.env.MCP_SCOPE || 'ask-nist-mcp';

// Agent Configuration (Agent Identity - Outbound) - FROM ENV
const AGENT_CLIENT_ID = process.env.AGENT_CLIENT_ID;
const AGENT_NAME = process.env.AGENT_NAME || 'NIST CSF 2.0 AI Agent';
const AGENT_PRIVATE_KEY_PATH = process.env.AGENT_PRIVATE_KEY_PATH || './agent-keys/agent-private-key.json';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';

// Validate required environment variables
const requiredEnvVars = [
  'OKTA_CLIENT_ID',
  'OKTA_CLIENT_SECRET',
  'AGENT_CLIENT_ID',
  'CUSTOM_AUTH_SERVER'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    console.error('Please copy .env.example to .env and configure all values.');
    process.exit(1);
  }
}

// Load agent private key
let agentPrivateKey;
try {
  const keyPath = join(__dirname, AGENT_PRIVATE_KEY_PATH);
  agentPrivateKey = JSON.parse(readFileSync(keyPath, 'utf-8'));
  console.log('Agent private key loaded successfully from:', AGENT_PRIVATE_KEY_PATH);
} catch (err) {
  console.error('Failed to load agent private key:', err.message);
  console.error('Please ensure the private key exists at:', AGENT_PRIVATE_KEY_PATH);
}

// Convert JWK to PEM for signing
function jwkToPem(jwk) {
  const keyObject = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'pkcs8', format: 'pem' });
}

// Generate client assertion JWT for private_key_jwt authentication
function generateClientAssertion(clientId, tokenEndpoint) {
  if (!agentPrivateKey) {
    throw new Error('Agent private key not loaded');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenEndpoint,
    iat: now,
    exp: now + 300, // 5 minutes
    jti: crypto.randomUUID()
  };

  const privateKeyPem = jwkToPem(agentPrivateKey);

  const assertion = jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    header: {
      alg: 'RS256',
      kid: agentPrivateKey.kid
    }
  });

  logToken('CLIENT_ASSERTION', assertion, {
    flow: 'private_key_jwt',
    endpoint: tokenEndpoint
  });

  return assertion;
}

// Agent token cache (for client credentials - agent's own identity)
let agentTokenCache = {
  accessToken: null,
  expiresAt: 0,
  parsed: null
};

// ID-JAG token cache (per user - agent acting on behalf of user)
const idJagTokenCache = new Map();

// Most recent PAM vaulted-secret exchange per user (users-mcp-server). This
// is metadata only - never the secret itself - kept so the "OAuth Token
// Architecture" viewer can show the real PAM flow after the agent has
// actually requested a key, instead of just the static ID-JAG diagram.
const vaultedSecretExchangeCache = new Map();

// Most recent PAM service-account exchange per user (users-mcp-server,
// get_salesforce_service_account). Same idea as vaultedSecretExchangeCache
// above, but for the service-account O4AA resource type - Okta returns a
// Salesforce username/password pair here instead of an arbitrary vaulted
// secret. Metadata only - the password is never cached.
const serviceAccountExchangeCache = new Map();

// Most recent Agent-to-Agent (A2A) delegation chain per user (users-mcp-
// server: Agent A -> ID-JAG for Agent B -> Agent B redeems it). Runs before
// both PAM exchanges above whenever they run, so this is populated
// alongside whichever of vaultedSecretExchangeCache/serviceAccountExchangeCache
// gets set. Unlike those two, this carries the raw ID-JAG and chained
// access token in the clear (see agent-a2a-chain.ts for why) - the Token
// Architecture viewer shows the `act` chain-of-custody claim from here.
const a2aChainCache = new Map();

// Which flow the agent most recently actually used for this user -
// 'nist-mcp', 'users-mcp', or 'salesforce-service-account' - set at the same
// point each respective cache above gets populated. The token viewer uses
// this to show only the diagram for whichever flow just ran, instead of all
// of them at once.
const lastAgentFlowCache = new Map();

// Get agent access token using client credentials flow with private_key_jwt
async function getAgentAccessToken(scopes = []) {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (agentTokenCache.accessToken && agentTokenCache.expiresAt > now + 60000) {
    return agentTokenCache;
  }

  const tokenEndpoint = `${OKTA_ISSUER}/v1/token`;

  try {
    const clientAssertion = generateClientAssertion(AGENT_CLIENT_ID, tokenEndpoint);

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
      scope: scopes.join(' ') || 'openid'
    });

    console.log('Requesting agent access token...');

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token request failed: ${response.status} - ${error}`);
    }

    const data = await response.json();

    // Cache the token
    agentTokenCache = {
      accessToken: data.access_token,
      expiresAt: now + (data.expires_in * 1000),
      parsed: parseJwt(data.access_token),
      tokenType: data.token_type,
      scope: data.scope
    };

    logToken('AGENT_ACCESS_TOKEN', data.access_token, {
      flow: 'client_credentials',
      endpoint: tokenEndpoint
    });

    console.log('Agent access token obtained successfully');
    return agentTokenCache;
  } catch (error) {
    console.error('Failed to get agent access token:', error);
    throw error;
  }
}

// Get access token for MCP (THREE-STEP PROCESS per Okta AI Agent spec)
// Step 1: Validate user is authenticated
// Step 2: Exchange user's ID token for ID-JAG token at ORG server
// Step 3: Exchange ID-JAG token for access token at CUSTOM server
async function getMcpAccessToken(userIdToken, userAccessToken, userId) {
  const now = Date.now();
  const cacheKey = userId;

  // Check cache
  const cached = idJagTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60000) {
    console.log('Using cached MCP access token for user:', userId);
    lastAgentFlowCache.set(userId, 'nist-mcp');
    return cached;
  }

  try {
    // STEP 1: Exchange user's ID token for ID-JAG at ORG server
    console.log('\n=== STEP 1: Get ID-JAG Token from ORG Server ===');
    console.log('User ID:', userId);
    console.log('Agent:', AGENT_CLIENT_ID);

    const orgClientAssertion = generateClientAssertion(AGENT_CLIENT_ID, ORG_TOKEN_ENDPOINT);

    const idJagParams = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      client_id: AGENT_CLIENT_ID,
      subject_token: userIdToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      audience: CUSTOM_AUTH_SERVER,
      scope: MCP_SCOPE,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: orgClientAssertion
    });

    console.log('Requesting ID-JAG from:', ORG_TOKEN_ENDPOINT);

    const idJagResponse = await fetch(ORG_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: idJagParams.toString()
    });

    if (!idJagResponse.ok) {
      const error = await idJagResponse.text();
      console.error('ID-JAG exchange failed:', error);
      throw new Error(`ID-JAG exchange failed: ${error}`);
    }

    const idJagData = await idJagResponse.json();
    const idJagToken = idJagData.access_token;

    logToken('ID-JAG_TOKEN (Step 1)', idJagToken, {
      flow: 'token_exchange → ID-JAG',
      user: userId,
      endpoint: ORG_TOKEN_ENDPOINT
    });

    console.log('✅ ID-JAG token received');
    console.log('   Token type:', idJagData.issued_token_type);

    // STEP 2: Exchange ID-JAG for access token at CUSTOM server (JWT Bearer Grant)
    console.log('\n=== STEP 2: Exchange ID-JAG for Access Token at CUSTOM Server ===');

    const customTokenEndpoint = `${CUSTOM_AUTH_SERVER}/v1/token`;
    const customClientAssertion = generateClientAssertion(AGENT_CLIENT_ID, customTokenEndpoint);

    const accessTokenParams = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: AGENT_CLIENT_ID,
      assertion: idJagToken,  // Use ID-JAG as assertion
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: customClientAssertion
      // Note: NO scope parameter - scope comes from ID-JAG token
    });

    console.log('Exchanging ID-JAG at:', customTokenEndpoint);

    const accessTokenResponse = await fetch(customTokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: accessTokenParams.toString()
    });

    if (!accessTokenResponse.ok) {
      const error = await accessTokenResponse.text();
      console.error('Access token exchange failed:', error);
      throw new Error(`Access token exchange failed: ${error}`);
    }

    const accessTokenData = await accessTokenResponse.json();

    logToken('MCP_ACCESS_TOKEN (Step 2)', accessTokenData.access_token, {
      flow: 'jwt_bearer → access_token',
      user: userId,
      endpoint: customTokenEndpoint
    });

    console.log('✅ MCP access token received');
    console.log('   Expires in:', accessTokenData.expires_in);
    console.log('   Scope:', accessTokenData.scope);

    const result = {
      accessToken: accessTokenData.access_token,
      idJagToken: idJagToken,  // Keep ID-JAG for reference
      expiresAt: now + ((accessTokenData.expires_in || 3600) * 1000),
      parsed: parseJwt(accessTokenData.access_token),
      tokenType: accessTokenData.token_type || 'Bearer',
      scope: accessTokenData.scope,
      actingParty: {
        agentId: AGENT_CLIENT_ID,
        agentName: AGENT_NAME
      },
      onBehalfOf: userId,
      fromOkta: true
    };

    idJagTokenCache.set(cacheKey, result);
    lastAgentFlowCache.set(userId, 'nist-mcp');
    console.log('✅ Tokens cached for user:', userId, '\n');

    return result;
  } catch (error) {
    console.error('Failed to get MCP access token:', error);

    // Return error state instead of fallback
    return {
      error: true,
      errorMessage: error.message,
      errorStep: error.message.includes('ID-JAG') ? 'step1' : 'step2',
      accessToken: null,
      idJagToken: null
    };
  }
}

// DEPRECATED: No longer using local fallback tokens
// All tokens must come from Okta for proper security
function generateLocalIdJagToken_DEPRECATED(userIdToken, userId) {
  if (!agentPrivateKey) {
    throw new Error('Agent private key not loaded');
  }

  const userClaims = parseJwt(userIdToken);
  const now = Math.floor(Date.now() / 1000);

  // Create ID-JAG token payload
  const payload = {
    // Standard JWT claims
    iss: AGENT_CLIENT_ID,  // Issued by the agent
    sub: userId,           // Subject is the user
    aud: MCP_SERVER_URL,   // Audience is the MCP server
    iat: now,
    exp: now + 3600,       // 1 hour
    jti: crypto.randomUUID(),

    // ID-JAG specific claims
    act: {
      // Actor claim - who is acting (the agent)
      sub: AGENT_CLIENT_ID,
      name: AGENT_NAME
    },

    // Delegated user info from the original ID token
    delegated_claims: {
      original_issuer: userClaims?.iss,
      user_sub: userClaims?.sub,
      user_email: userClaims?.email,
      user_name: userClaims?.name
    },

    // Token type identifier
    token_type: 'id_jag',

    // Scope of delegation
    scope: 'mcp:query mcp:assess'
  };

  const privateKeyPem = jwkToPem(agentPrivateKey);

  const token = jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    header: {
      alg: 'RS256',
      kid: agentPrivateKey.kid,
      typ: 'at+jwt'  // Access token JWT type
    }
  });

  console.log('Generated local ID-JAG token for user:', userId);

  return {
    accessToken: token,
    idJagToken: token,  // Include for display in UI
    expiresAt: Date.now() + 3600000,
    parsed: payload,
    tokenType: 'Bearer',
    scope: 'mcp:query mcp:assess',
    isLocal: true,
    actingParty: {
      agentId: AGENT_CLIENT_ID,
      agentName: AGENT_NAME
    },
    onBehalfOf: userId,
    fromOkta: false
  };
}

// Session configuration
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Helper to parse JWT token
function parseJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload;
  } catch (e) {
    return null;
  }
}

// Configure OpenID Connect Strategy for Okta (User Authentication)
passport.use('oidc', new OpenIDConnectStrategy({
  issuer: OKTA_ISSUER,
  authorizationURL: `${OKTA_DOMAIN}/oauth2/v1/authorize`,
  tokenURL: `${OKTA_DOMAIN}/oauth2/v1/token`,
  userInfoURL: `${OKTA_DOMAIN}/oauth2/v1/userinfo`,
  clientID: OKTA_CLIENT_ID,
  clientSecret: OKTA_CLIENT_SECRET,
  callbackURL: OKTA_REDIRECT_URI,
  scope: 'openid profile email',
  passReqToCallback: true
}, function verify(req, issuer, profile, context, idToken, accessToken, refreshToken, cb) {
  console.log('OIDC verify callback:', { issuer, profileId: profile?.id, hasIdToken: !!idToken, hasAccessToken: !!accessToken });
  try {
    const user = {
      id: profile.id,
      displayName: profile.displayName || profile._json?.name,
      email: profile._json?.email || profile.emails?.[0]?.value,
      firstName: profile._json?.given_name || profile.name?.givenName,
      lastName: profile._json?.family_name || profile.name?.familyName,
      idToken: idToken,
      accessToken: accessToken,
      idTokenParsed: parseJwt(idToken),
      accessTokenParsed: parseJwt(accessToken)
    };

    logToken('USER_ID_TOKEN (OIDC Login)', idToken, {
      flow: 'authorization_code',
      user: profile._json?.email || profile.id
    });
    logToken('USER_ACCESS_TOKEN (OIDC Login)', accessToken, {
      flow: 'authorization_code',
      user: profile._json?.email || profile.id
    });

    console.log('User created with tokens');
    return cb(null, user);
  } catch (err) {
    console.error('Error in OIDC verify:', err);
    return cb(err);
  }
}));

// Middleware
app.use(cors());
app.use(express.json());

// Authentication check middleware
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated', loginUrl: '/login' });
}

// Login route - redirects to Okta
app.get('/login', passport.authenticate('oidc'));

// OAuth callback route
app.get('/authorization-code/callback', (req, res, next) => {
  console.log('Callback received, query:', req.query);
  passport.authenticate('oidc', (err, user, info) => {
    console.log('Passport authenticate result:', { err, user, info });
    if (err) {
      console.error('Authentication error:', err);
      return res.redirect('/login-error?error=' + encodeURIComponent(err.message || 'Unknown error'));
    }
    if (!user) {
      console.error('No user returned:', info);
      return res.redirect('/login-error?error=' + encodeURIComponent(info?.message || 'No user'));
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('Login error:', loginErr);
        return res.redirect('/login-error?error=' + encodeURIComponent(loginErr.message));
      }
      console.log('User logged in successfully:', user);
      return res.redirect('/');
    });
  })(req, res, next);
});

// Login error route
app.get('/login-error', (req, res) => {
  const error = req.query.error || 'Unknown error';
  console.error('Login error page:', error);
  res.status(401).send(`
    <h2>Authentication Failed</h2>
    <p>Error: ${error}</p>
    <p><a href="/login">Try again</a></p>
  `);
});

// Session expired / disconnected route
app.get('/session-expired', (req, res) => {
  const reason = req.query.reason || 'Your session has expired';
  res.status(401).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Session Expired - NIST CSF 2.0 AI Agent</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #1a1a2e;
          color: #eee;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
        }
        .container {
          text-align: center;
          max-width: 500px;
          padding: 2rem;
        }
        h1 {
          color: #f59e0b;
          font-size: 1.5rem;
          margin-bottom: 1rem;
        }
        p {
          color: #94a3b8;
          margin-bottom: 1.5rem;
          line-height: 1.6;
        }
        a {
          display: inline-block;
          background: #3b82f6;
          color: white;
          text-decoration: none;
          padding: 0.75rem 2rem;
          border-radius: 8px;
          font-weight: 500;
          transition: background 0.2s;
        }
        a:hover {
          background: #2563eb;
        }
        .icon {
          font-size: 3rem;
          margin-bottom: 1rem;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">🔒</div>
        <h1>You Have Been Disconnected</h1>
        <p>${reason}</p>
        <a href="/login">Click Here to Log In Again</a>
      </div>
    </body>
    </html>
  `);
});

// Logout route - Clear local session and redirect to Okta logout
app.get('/logout', (req, res, next) => {
  const idToken = req.user?.idToken;

  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
      return next(err);
    }

    // Destroy local session
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        console.error('Session destroy error:', destroyErr);
      }

      // If we have an ID token, use Okta logout to clear SSO session
      if (idToken) {
        const oktaLogoutUrl = `${OKTA_DOMAIN}/oauth2/v1/logout?id_token_hint=${idToken}&post_logout_redirect_uri=${encodeURIComponent(OKTA_LOGOUT_REDIRECT_URI + '/session-expired?reason=You have been logged out successfully')}`;
        res.redirect(oktaLogoutUrl);
      } else {
        // Fallback to local logout
        res.redirect('/session-expired?reason=You have been logged out successfully');
      }
    });
  });
});

// Get current user info
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    const { idToken, accessToken, idTokenParsed, accessTokenParsed, ...userInfo } = req.user;
    res.json({
      authenticated: true,
      user: userInfo
    });
  } else {
    res.json({
      authenticated: false,
      user: null,
      loginUrl: '/login'
    });
  }
});

// Get user tokens (Inbound - user's tokens)
app.get('/api/tokens', ensureAuthenticated, (req, res) => {
  res.json({
    idToken: {
      raw: req.user.idToken,
      parsed: req.user.idTokenParsed
    },
    accessToken: {
      raw: req.user.accessToken,
      parsed: req.user.accessTokenParsed
    }
  });
});

// Get agent info
app.get('/api/agent', (req, res) => {
  res.json({
    name: AGENT_NAME,
    clientId: AGENT_CLIENT_ID,
    keyId: agentPrivateKey?.kid || 'not loaded',
    issuer: OKTA_ISSUER,
    hasPrivateKey: !!agentPrivateKey
  });
});

// Get ID-JAG token (AI Agent token exchange)
app.get('/api/agent/tokens', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    console.log('=== /api/agent/tokens called for user:', user.id, user.email);

    // Read from cache only - never trigger a live ID-JAG/MCP exchange just
    // because the token viewer was opened. That exchange is a side effect of
    // an actual /api/chat call, so steps 2/3 stay hidden in the viewer until
    // the user has really interacted with the agent at least once this
    // session (idJagTokenCache only gets a successful result, never an
    // in-progress or failed attempt - see getMcpAccessToken).
    const tokenData = idJagTokenCache.get(user.id) || null;
    const interacted = Boolean(tokenData);
    // Which flow (nist-mcp / users-mcp) actually ran most recently, so the
    // viewer can show only that one's diagram instead of both at once.
    const lastFlow = lastAgentFlowCache.get(user.id) || null;
    console.log('Agent interaction so far this session:', interacted, 'lastFlow:', lastFlow);

    res.json({
      description: 'Agent ID Assertion - Token exchange for agent acting on behalf of user',
      interacted,
      lastFlow,
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email
      },
      agent: {
        name: AGENT_NAME,
        clientId: AGENT_CLIENT_ID,
        authMethod: 'Agent ID Assertion (private_key_jwt + token_exchange)'
      },
      webappClientId: OKTA_CLIENT_ID,
      orgAuthServer: `${OKTA_DOMAIN}/oauth2/v1`,
      customAuthServer: CUSTOM_AUTH_SERVER,
      idJagToken: tokenData?.idJagToken ? {
        description: 'ID-JAG token from ORG server (step 2)',
        raw: tokenData.idJagToken,
        parsed: parseJwt(tokenData.idJagToken),
        fromOkta: tokenData.fromOkta
      } : null,
      mcpAccessToken: tokenData?.accessToken ? {
        description: 'MCP access token from CUSTOM server (step 3)',
        raw: tokenData.accessToken,
        parsed: tokenData.parsed,
        expiresAt: tokenData.expiresAt ? new Date(tokenData.expiresAt).toISOString() : null,
        tokenType: tokenData.tokenType,
        scope: tokenData.scope,
        fromOkta: tokenData.fromOkta
      } : null,
      // Populated only after the agent has actually run the A2A delegation
      // chain at least once (Agent A -> ID-JAG for Agent B -> Agent B
      // redeems it), which happens immediately before either PAM exchange
      // below. Unlike those, the raw ID-JAG and chained access token are
      // included in the clear - see agent-a2a-chain.ts for why that's safe.
      a2aChain: (() => {
        const cached = a2aChainCache.get(user.id);
        if (!cached) return null;
        return {
          description: 'A2A delegation chain: Agent A -> ID-JAG for Agent B -> Agent B redeems it',
          requestedAt: cached.requestedAt,
          agentAClientId: cached.a2aChain.agentAClientId,
          agentBClientId: cached.a2aChain.agentBClientId,
          hop1: {
            ...cached.a2aChain.hop1,
            clientAssertion: {
              raw: cached.a2aChain.hop1.clientAssertion,
              parsed: parseJwt(cached.a2aChain.hop1.clientAssertion)
            }
          },
          hop1Redeem: {
            ...cached.a2aChain.hop1Redeem,
            clientAssertion: {
              raw: cached.a2aChain.hop1Redeem.clientAssertion,
              parsed: parseJwt(cached.a2aChain.hop1Redeem.clientAssertion)
            }
          },
          chainedAccessToken: {
            raw: cached.a2aChain.chainedAccessToken,
            parsed: cached.a2aChain.chainedAccessTokenClaims
          }
        };
      })(),
      // Populated only after the agent has actually called search_users at
      // least once - the PAM vaulted-secret flow is request-triggered, not
      // pre-fetched like the ID-JAG dance above. The secret itself is never
      // included, only the exchange metadata.
      vaultedSecretExchange: (() => {
        const cached = vaultedSecretExchangeCache.get(user.id);
        if (!cached) return null;
        return {
          description: 'PAM vaulted-secret exchange for users-mcp-server (search_users)',
          requestedAt: cached.requestedAt,
          toolInput: cached.toolInput,
          resultCount: cached.resultCount,
          success: cached.success,
          usersMcpServerUrl: cached.usersMcpServerUrl,
          tokenEndpoint: cached.pamExchange.tokenEndpoint,
          resource: cached.pamExchange.resource,
          requestedTokenType: cached.pamExchange.requestedTokenType,
          issuedTokenType: cached.pamExchange.issuedTokenType,
          subjectTokenType: cached.pamExchange.subjectTokenType,
          expiresIn: cached.pamExchange.expiresIn,
          clientAssertion: {
            raw: cached.pamExchange.clientAssertion,
            parsed: parseJwt(cached.pamExchange.clientAssertion)
          },
          // Okta's actual token-exchange response, verbatim, with only the
          // secret value inside vaulted_secret swapped for "REDACTED" - see
          // redactVaultedSecretResponse() in users-mcp-server. The real key
          // is not included here; it's only ever sent to the browser via the
          // explicit "DEBUG" button, which hits /api/agent/debug-reveal-secret
          // below - a separate, deliberate opt-in action.
          rawResponseRedacted: cached.pamExchange.rawResponseRedacted
        };
      })(),
      // Populated only after the agent has actually called
      // get_salesforce_service_account at least once - mirrors
      // vaultedSecretExchange above, but for the service-account exchange.
      // The password is never included, only the exchange metadata plus the
      // (non-secret) username and the downstream Salesforce login outcome.
      serviceAccountExchange: (() => {
        const cached = serviceAccountExchangeCache.get(user.id);
        if (!cached) return null;
        return {
          description: 'PAM service-account exchange for users-mcp-server (get_salesforce_service_account)',
          requestedAt: cached.requestedAt,
          username: cached.username,
          salesforceLogin: cached.salesforceLogin,
          success: cached.success,
          usersMcpServerUrl: cached.usersMcpServerUrl,
          tokenEndpoint: cached.pamExchange.tokenEndpoint,
          resource: cached.pamExchange.resource,
          requestedTokenType: cached.pamExchange.requestedTokenType,
          issuedTokenType: cached.pamExchange.issuedTokenType,
          subjectTokenType: cached.pamExchange.subjectTokenType,
          expiresIn: cached.pamExchange.expiresIn,
          clientAssertion: {
            raw: cached.pamExchange.clientAssertion,
            parsed: parseJwt(cached.pamExchange.clientAssertion)
          },
          // Okta's actual token-exchange response, verbatim, with only
          // service_account.password swapped for "REDACTED" - see
          // redactServiceAccountResponse() in users-mcp-server. The real
          // password is not included here; it's only ever sent to the
          // browser via the "DEBUG" button, which hits
          // /api/agent/debug-reveal-service-account below.
          rawResponseRedacted: cached.pamExchange.rawResponseRedacted
        };
      })()
    });
  } catch (error) {
    console.error('Error in /api/agent/tokens:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Local-debugging-only: proxies to users-mcp-server's own debug endpoint to
// reveal the real value of the most recent PAM vaulted-secret exchange, for
// the "DEBUG" button in the Token Architecture viewer. Explicit opt-in
// action only - never included in the normal /api/agent/tokens response.
app.get('/api/agent/debug-reveal-secret', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const response = await fetch(`${USERS_MCP_SERVER_URL}/api/debug/reveal-secret`, {
      headers: { 'Authorization': `Bearer ${user.idToken}` }
    });
    const result = await response.json();
    res.status(response.status).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Local-debugging-only: proxies to users-mcp-server's own debug endpoint to
// reveal the real value (username/password) of the most recent PAM
// service-account exchange. Mirrors /api/agent/debug-reveal-secret above,
// for the get_salesforce_service_account flow instead of search_users.
app.get('/api/agent/debug-reveal-service-account', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const response = await fetch(`${USERS_MCP_SERVER_URL}/api/debug/reveal-service-account`, {
      headers: { 'Authorization': `Bearer ${user.idToken}` }
    });
    const result = await response.json();
    res.status(response.status).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate a fresh client assertion (for debugging/demo)
app.get('/api/agent/assertion', ensureAuthenticated, (req, res) => {
  try {
    const tokenEndpoint = `${OKTA_ISSUER}/v1/token`;
    const assertion = generateClientAssertion(AGENT_CLIENT_ID, tokenEndpoint);
    res.json({
      clientAssertion: assertion,
      parsed: parseJwt(assertion),
      usage: {
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        token_endpoint: tokenEndpoint
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get ID-JAG token (agent acting on behalf of user)
app.get('/api/agent/id-jag', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const idJagToken = await getIdJagToken(user.idToken, user.id);

    res.json({
      description: 'ID-JAG (Identity JWT Agent Grant) - Agent acting on behalf of user',
      flow: {
        step1: 'User authenticates via Okta SSO → receives ID token',
        step2: 'Agent uses private_key_jwt to authenticate itself',
        step3: 'Agent exchanges user ID token for ID-JAG token',
        step4: 'Agent uses ID-JAG token to call MCP on behalf of user'
      },
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email
      },
      agent: {
        clientId: AGENT_CLIENT_ID,
        name: AGENT_NAME
      },
      idJagToken: {
        raw: idJagToken.accessToken,
        parsed: idJagToken.parsed,
        expiresAt: new Date(idJagToken.expiresAt).toISOString(),
        tokenType: idJagToken.tokenType,
        scope: idJagToken.scope,
        isLocal: idJagToken.isLocal || false
      }
    });
  } catch (error) {
    console.error('ID-JAG token error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  const mcpHealth = await fetch(`${MCP_SERVER_URL}/health`).then(r => r.json()).catch(() => ({ status: 'unavailable' }));
  res.json({
    status: 'ok',
    agent: {
      name: AGENT_NAME,
      clientId: AGENT_CLIENT_ID,
      keyLoaded: !!agentPrivateKey
    },
    llm: { baseUrl: LITELLM_BASE_URL || '(resolving via ocm)', model: MODEL, auth: 'ocm' },
    mcp: mcpHealth
  });
});

// search_users is served by users-mcp-server, independently of the NIST MCP server
const USERS_MCP_TOOL_DEFINITION = {
  name: 'search_users',
  description: 'Search Okta users by first name, last name, and/or email',
  input_schema: {
    type: 'object',
    properties: {
      firstName: { type: 'string', description: 'First name to search for' },
      lastName: { type: 'string', description: 'Last name to search for' },
      email: { type: 'string', description: 'Email address to search for' },
      limit: { type: 'number', description: 'Maximum results (1-200)', default: 20 }
    }
  }
};

// get_salesforce_service_account is also served by users-mcp-server - a
// different O4AA resource type (service-account) than search_users's
// vaulted-secret exchange. See users-mcp-server/src/services/
// okta-service-account-exchange.ts.
const SALESFORCE_SERVICE_ACCOUNT_TOOL_DEFINITION = {
  name: 'get_salesforce_service_account',
  description: 'Retrieve the Salesforce service-account credential vaulted in Okta Privileged Access Management (PAM), via an O4AA service-account token exchange. Use when the user asks to access/log into Salesforce as the service account, or to fetch/retrieve/check out the Salesforce PAM-vaulted credential.',
  input_schema: {
    type: 'object',
    properties: {}
  }
};

// Get MCP tools in Anthropic format
async function getMcpToolsForClaude() {
  const toolDefinitions = [USERS_MCP_TOOL_DEFINITION, SALESFORCE_SERVICE_ACCOUNT_TOOL_DEFINITION];

  try {
    const response = await fetch(`${MCP_SERVER_URL}/api/tools`);
    if (!response.ok) return toolDefinitions;

    // Convert simple tool list to full tool definitions
    // For now, return a subset of most useful tools
    toolDefinitions.push(
      {
        name: 'csf_lookup',
        description: 'Look up NIST CSF elements by identifier (function, category, or subcategory ID)',
        input_schema: {
          type: 'object',
          properties: {
            identifier: { type: 'string', description: 'CSF identifier (e.g., GV, PR.AA, DE.CM-01)' }
          },
          required: ['identifier']
        }
      },
      {
        name: 'search_framework',
        description: 'Search the NIST CSF framework for keywords or concepts',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query or keyword' }
          },
          required: ['query']
        }
      },
      {
        name: 'get_assessment_questions',
        description: 'Get assessment questions for a specific subcategory',
        input_schema: {
          type: 'object',
          properties: {
            subcategory_id: { type: 'string', description: 'Subcategory ID (e.g., GV.OC-01)' }
          },
          required: ['subcategory_id']
        }
      }
    );

    return toolDefinitions;
  } catch (error) {
    console.error('Failed to get MCP tools:', error);
    return toolDefinitions;
  }
}

// Execute MCP tool with ID-JAG token
async function executeMcpTool(toolName, toolInput, idJagToken) {
  try {
    console.log(`Executing MCP tool: ${toolName}`);

    const response = await fetch(`${MCP_SERVER_URL}/api/tools/${toolName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idJagToken}`  // Use ID-JAG token!
      },
      body: JSON.stringify(toolInput)
    });

    const result = await response.json();
    console.log(`Tool ${toolName} completed:`, result.success ? 'SUCCESS' : 'FAILED');

    return result;
  } catch (error) {
    console.error(`Tool ${toolName} error:`, error);
    return { error: error.message };
  }
}

// Execute the search_users tool against users-mcp-server.
// Unlike executeMcpTool (which uses the ID-JAG/MCP access token), this
// passes the user's RAW ID token as Bearer - users-mcp-server needs it as
// the subject_token for its own vaulted-secret exchange (fetched fresh on
// every call, no caching).
async function executeUsersMcpTool(toolInput, userIdToken, userId) {
  try {
    console.log('Executing users-mcp-server tool: search_users');

    const response = await fetch(`${USERS_MCP_SERVER_URL}/api/tools/search-users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userIdToken}`  // Raw user ID token, not ID-JAG!
      },
      body: JSON.stringify(toolInput)
    });

    const result = await response.json();
    console.log('Tool search_users completed:', result.success ? 'SUCCESS' : 'FAILED');

    // Record the PAM exchange metadata (never the secret) so the Token
    // Architecture viewer can show the real flow the agent just ran.
    if (result.data?.pamExchange) {
      lastAgentFlowCache.set(userId, 'users-mcp');
      vaultedSecretExchangeCache.set(userId, {
        pamExchange: result.data.pamExchange,
        requestedAt: result.data.pamExchange.fetchedAt || new Date().toISOString(),
        toolInput,
        resultCount: result.data.count ?? null,
        success: Boolean(result.data.success),
        usersMcpServerUrl: USERS_MCP_SERVER_URL
      });
    }

    // Record the A2A delegation chain that ran before the PAM exchange
    // above (Agent A -> ID-JAG for Agent B -> Agent B redeems it) so the
    // Token Architecture viewer can show every hop, including the `act`
    // chain-of-custody claim on the chained access token.
    if (result.data?.a2aChain) {
      a2aChainCache.set(userId, {
        a2aChain: result.data.a2aChain,
        requestedAt: result.data.a2aChain.fetchedAt || new Date().toISOString()
      });
    }

    return result;
  } catch (error) {
    console.error('Tool search_users error:', error);
    return { error: error.message };
  }
}

// Execute the get_salesforce_service_account tool against users-mcp-server.
// Same auth pattern as executeUsersMcpTool - the raw user ID token is the
// subject_token for users-mcp-server's own service-account exchange
// (fetched fresh on every call, no caching).
async function executeSalesforceServiceAccountTool(toolInput, userIdToken, userId) {
  try {
    console.log('Executing users-mcp-server tool: get_salesforce_service_account');

    const response = await fetch(`${USERS_MCP_SERVER_URL}/api/tools/get-salesforce-service-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userIdToken}`  // Raw user ID token, not ID-JAG!
      },
      body: JSON.stringify(toolInput)
    });

    const result = await response.json();
    console.log('Tool get_salesforce_service_account completed:', result.success ? 'SUCCESS' : 'FAILED');

    // Record the PAM service-account exchange metadata (never the password)
    // so the Token Architecture viewer can show the real flow the agent
    // just ran - same convention as executeUsersMcpTool's
    // vaultedSecretExchangeCache above.
    if (result.data?.pamExchange) {
      lastAgentFlowCache.set(userId, 'salesforce-service-account');
      serviceAccountExchangeCache.set(userId, {
        pamExchange: result.data.pamExchange,
        requestedAt: result.data.pamExchange.fetchedAt || new Date().toISOString(),
        username: result.data.username ?? null,
        salesforceLogin: result.data.salesforceLogin ?? null,
        success: Boolean(result.data.success),
        usersMcpServerUrl: USERS_MCP_SERVER_URL
      });
    }

    // Same A2A chain recording as executeUsersMcpTool above.
    if (result.data?.a2aChain) {
      a2aChainCache.set(userId, {
        a2aChain: result.data.a2aChain,
        requestedAt: result.data.a2aChain.fetchedAt || new Date().toISOString()
      });
    }

    return result;
  } catch (error) {
    console.error('Tool get_salesforce_service_account error:', error);
    return { error: error.message };
  }
}

// Chat endpoint with MCP tool support
app.post('/api/chat', ensureAuthenticated, async (req, res) => {
  try {
    const { messages } = req.body;
    const user = req.user;

    console.log(`\n=== Chat Request from ${user.email} ===`);

    // Get MCP tools
    const tools = await getMcpToolsForClaude();
    console.log(`Loaded ${tools.length} MCP tools for Claude`);

    // System prompt
    const systemPrompt = `You are the ${AGENT_NAME}, an AI Agent helping ${user.displayName || user.email}.

You have access to ${tools.length} MCP tools:
- csf_lookup: Look up specific NIST CSF 2.0 framework elements
- search_framework: Search the NIST CSF 2.0 framework for keywords and concepts
- get_assessment_questions: Get NIST CSF 2.0 assessment questions for subcategories
- search_users: Search Okta users by first name, last name, and/or email
- get_salesforce_service_account: Retrieve the Salesforce service-account credential vaulted in Okta PAM (O4AA service-account token exchange)

Use these tools to provide accurate, data-driven answers.`;

    const requestBody = {
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
      tools: tools.length > 0 ? tools : undefined
    };

    console.log('Calling Claude...');
    let response = await callLiteLLM('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LiteLLM error: ${response.status} - ${error}`);
    }

    let result = await response.json();

    // Handle tool use loop
    let iteration = 0;
    const maxIterations = 5;

    while (result.stop_reason === 'tool_use' && iteration < maxIterations) {
      iteration++;
      console.log(`\n--- Tool Use Iteration ${iteration} ---`);

      const toolUseBlocks = result.content.filter(b => b.type === 'tool_use');
      console.log(`Claude wants to use ${toolUseBlocks.length} tool(s)`);

      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`  Tool: ${toolUse.name}`);
        console.log(`  Input:`, JSON.stringify(toolUse.input));

        // ID-JAG exchange is fetched lazily, right here, only when a NIST
        // MCP tool is actually about to be called - mirroring the PAM
        // exchange's own on-demand pattern. This keeps idJagTokenCache
        // (and lastAgentFlowCache) from getting populated by chat messages
        // that never touch the NIST MCP server.
        let toolResult;
        if (toolUse.name === 'search_users') {
          toolResult = await executeUsersMcpTool(toolUse.input, user.idToken, user.id);
        } else if (toolUse.name === 'get_salesforce_service_account') {
          toolResult = await executeSalesforceServiceAccountTool(toolUse.input, user.idToken, user.id);
        } else {
          let mcpAccessToken = null;
          try {
            const tokenData = await getMcpAccessToken(user.idToken, user.accessToken, user.id);
            mcpAccessToken = tokenData.accessToken;
            console.log('MCP access token obtained (via ID-JAG)');
          } catch (e) {
            console.error('Failed to get MCP access token:', e.message);
          }
          toolResult = await executeMcpTool(toolUse.name, toolUse.input, mcpAccessToken);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        });
      }

      // Continue conversation with tool results
      messages.push(
        { role: 'assistant', content: result.content },
        { role: 'user', content: toolResults }
      );

      console.log('Sending tool results back to Claude...');
      response = await callLiteLLM('/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          messages: messages,
          tools: tools
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LiteLLM error: ${response.status} - ${error}`);
      }

      result = await response.json();
    }

    console.log('Chat completed after', iteration, 'tool iterations\n');
    res.json(result);

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get tools list
app.get('/api/tools', ensureAuthenticated, async (req, res) => {
  try {
    const response = await fetch(`${MCP_SERVER_URL}/api/tools`);
    const data = await response.json();
    res.json({ tools: data.tools, count: data.tools?.length || 0 });
  } catch (error) {
    res.json({ tools: [], count: 0, error: error.message });
  }
});

// Checks one registered MCP server's /health + /api/tools. Shared by the
// "MCP Server Status & Tools" modal endpoint below and the startup verbose
// printer, so both always agree on what's actually online.
async function checkMcpServer(server) {
  try {
    const [healthRes, toolsRes] = await Promise.all([
      fetch(`${server.url}/health`),
      fetch(`${server.url}/api/tools`)
    ]);

    if (!healthRes.ok) {
      throw new Error(`Health check failed: ${healthRes.status}`);
    }

    const health = await healthRes.json();
    const toolsData = toolsRes.ok ? await toolsRes.json() : { tools: [] };

    return {
      key: server.key,
      name: server.name,
      url: server.url,
      online: true,
      status: health.status || 'unknown',
      version: health.version || null,
      mode: health.mode || null,
      toolsCount: toolsData.tools?.length ?? health.tools_available ?? 0,
      tools: toolsData.tools || [],
      error: null
    };
  } catch (error) {
    return {
      key: server.key,
      name: server.name,
      url: server.url,
      online: false,
      status: 'offline',
      version: null,
      mode: null,
      toolsCount: 0,
      tools: [],
      error: error.message
    };
  }
}

// Status + tool inventory for every registered MCP server. Drives the
// "MCP Server Status & Tools" modal - add a server to MCP_SERVERS and it
// shows up here automatically.
app.get('/api/mcp-servers', ensureAuthenticated, async (req, res) => {
  const servers = await Promise.all(MCP_SERVERS.map(checkMcpServer));

  res.json({ servers });
});

// Serve static files
app.get('/', (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/login');
  }
  next();
}, express.static(join(__dirname, 'public')));

app.use(express.static(join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║     ${AGENT_NAME} (Okta Protected)                  ║
╠═══════════════════════════════════════════════════════════════════╣
║  Web UI:        http://localhost:${PORT}                             ║
║  Login:         http://localhost:${PORT}/login                       ║
║  Logout:        http://localhost:${PORT}/logout                      ║
╠═══════════════════════════════════════════════════════════════════╣
║  INBOUND AUTH (User):                                             ║
║  └─ Client ID:  ${OKTA_CLIENT_ID}                        ║
╠═══════════════════════════════════════════════════════════════════╣
║  OUTBOUND AUTH (Agent):                                           ║
║  └─ Client ID:  ${AGENT_CLIENT_ID}                        ║
║  └─ Key ID:     ${agentPrivateKey?.kid || 'not loaded'}     ║
║  └─ Auth Type:  private_key_jwt (RS256)                           ║
╠═══════════════════════════════════════════════════════════════════╣
║  LiteLLM:       ${(LITELLM_BASE_URL || '(resolving via ocm)').padEnd(46)}║
║  LLM Auth:      ${'ocm auth litellm'.padEnd(46)}║
║  NIST MCP:      ${MCP_SERVER_URL.padEnd(46)}║
║  Users MCP:     ${USERS_MCP_SERVER_URL.padEnd(46)}║
║  Okta Issuer:   ${OKTA_ISSUER.substring(0, 46)}║
╚═══════════════════════════════════════════════════════════════════╝
  `);
  printMcpServerStatusOnBoot();
});

// The webapp, nist-mcp-server, and users-mcp-server all start concurrently
// (see the root "start" npm script), so the sub-servers aren't necessarily
// up yet the instant this callback fires. Poll each with checkMcpServer()
// until it responds (or we give up) and print one status + tool-count line
// per server, in MCP_SERVERS order, so both are visible in the startup
// output - not just whichever sub-process's own banner happened to log
// first.
async function printMcpServerStatusOnBoot() {
  const maxAttempts = 20;
  const retryDelayMs = 500;

  const results = await Promise.all(MCP_SERVERS.map(async (server) => {
    let result = await checkMcpServer(server);
    for (let attempt = 1; attempt < maxAttempts && !result.online; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      result = await checkMcpServer(server);
    }
    return result;
  }));

  console.log('🔧 MCP Servers:');
  for (const result of results) {
    const status = result.online
      ? `✅ online · ${result.toolsCount} tool${result.toolsCount === 1 ? '' : 's'}`
      : `❌ offline (${result.error})`;
    console.log(`   ${result.name.padEnd(24)} ${result.url.padEnd(28)} ${status}`);
  }
}

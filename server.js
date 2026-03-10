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
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

const app = express();

// Configuration from environment
const LITELLM_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://llm.atko.ai';
const LITELLM_API_KEY = process.env.LITELLM_KEY || process.env.ANTHROPIC_API_KEY;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:8080';
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

  return jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    header: {
      alg: 'RS256',
      kid: agentPrivateKey.kid
    }
  });
}

// Agent token cache (for client credentials - agent's own identity)
let agentTokenCache = {
  accessToken: null,
  expiresAt: 0,
  parsed: null
};

// ID-JAG token cache (per user - agent acting on behalf of user)
const idJagTokenCache = new Map();

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
    console.log('✅ ID-JAG token received');
    console.log('   Token type:', idJagData.issued_token_type);

    // STEP 2: Exchange ID-JAG for access token at CUSTOM server (JWT Bearer Grant)
    console.log('\n=== STEP 2: Exchange ID-JAG for Access Token at CUSTOM Server ===');

    const customTokenEndpoint = `${CUSTOM_AUTH_SERVER}/v1/token`;

    const accessTokenParams = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: AGENT_CLIENT_ID,
      assertion: idJagToken,  // Use ID-JAG as assertion
      scope: MCP_SCOPE
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
    console.log('✅ Tokens cached for user:', userId, '\n');

    return result;
  } catch (error) {
    console.error('Failed to get MCP access token:', error);
    return generateLocalIdJagToken(userIdToken, userId);
  }
}

// Generate a local ID-JAG token when token exchange is not supported
// This creates a JWT signed by the agent that encapsulates the delegation
function generateLocalIdJagToken(userIdToken, userId) {
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

    // Get MCP access token (via ID-JAG exchange - agent on behalf of user)
    console.log('Getting MCP access token via AI Agent exchange...');
    const tokenData = await getMcpAccessToken(user.idToken, user.accessToken, user.id);
    console.log('Token obtained:', { fromOkta: tokenData.fromOkta });

    res.json({
      description: 'Agent ID Assertion - Token exchange for agent acting on behalf of user',
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
      webappClientId: OKTA_CLIENT_ID,  // Add webapp client ID
      orgAuthServer: `${OKTA_DOMAIN}/oauth2/v1`,  // Add ORG server
      customAuthServer: CUSTOM_AUTH_SERVER,  // Add custom server
      idJagToken: {
        description: 'ID-JAG token from ORG server (step 1)',
        raw: tokenData.idJagToken,
        parsed: parseJwt(tokenData.idJagToken),
        fromOkta: tokenData.fromOkta
      },
      mcpAccessToken: {
        description: 'MCP access token from CUSTOM server (step 2)',
        raw: tokenData.accessToken,
        parsed: tokenData.parsed,
        expiresAt: new Date(tokenData.expiresAt).toISOString(),
        tokenType: tokenData.tokenType,
        scope: tokenData.scope,
        fromOkta: tokenData.fromOkta
      }
    });
  } catch (error) {
    console.error('Error in /api/agent/tokens:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
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
    llm: { baseUrl: LITELLM_BASE_URL, model: MODEL },
    mcp: mcpHealth
  });
});

// Get MCP tools in Anthropic format
async function getMcpToolsForClaude() {
  try {
    const response = await fetch(`${MCP_SERVER_URL}/api/tools`);
    if (!response.ok) return [];

    const data = await response.json();

    // Convert simple tool list to full tool definitions
    // For now, return a subset of most useful tools
    const toolDefinitions = [
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
    ];

    return toolDefinitions;
  } catch (error) {
    console.error('Failed to get MCP tools:', error);
    return [];
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

// Chat endpoint with MCP tool support
app.post('/api/chat', ensureAuthenticated, async (req, res) => {
  try {
    const { messages } = req.body;
    const user = req.user;

    console.log(`\n=== Chat Request from ${user.email} ===`);

    // Get MCP access token (via ID-JAG exchange)
    let mcpAccessToken = null;
    try {
      const tokenData = await getMcpAccessToken(user.idToken, user.accessToken, user.id);
      mcpAccessToken = tokenData.accessToken;
      console.log('MCP access token obtained (via ID-JAG)');
    } catch (e) {
      console.error('Failed to get MCP access token:', e.message);
    }

    // Get MCP tools
    const tools = await getMcpToolsForClaude();
    console.log(`Loaded ${tools.length} MCP tools for Claude`);

    // System prompt
    const systemPrompt = `You are the ${AGENT_NAME}, an AI Agent helping ${user.displayName || user.email}.

You have access to ${tools.length} MCP tools to query the NIST Cybersecurity Framework 2.0 database:
- csf_lookup: Look up specific framework elements
- search_framework: Search for keywords and concepts
- get_assessment_questions: Get assessment questions for subcategories

Use these tools to provide accurate, data-driven answers about NIST CSF 2.0.`;

    const requestBody = {
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
      tools: tools.length > 0 ? tools : undefined
    };

    console.log('Calling Claude...');
    let response = await fetch(`${LITELLM_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': LITELLM_API_KEY,
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

        const toolResult = await executeMcpTool(toolUse.name, toolUse.input, mcpAccessToken);

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
      response = await fetch(`${LITELLM_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': LITELLM_API_KEY,
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
║  LiteLLM:       ${LITELLM_BASE_URL.padEnd(46)}║
║  MCP Server:    ${MCP_SERVER_URL.padEnd(46)}║
║  Okta Issuer:   ${OKTA_ISSUER.substring(0, 46)}║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});

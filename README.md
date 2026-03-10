# NIST CSF 2.0 AI Chatbot Web Application

> ⚠️ **EXPERIMENTAL CODE - NOT FOR PRODUCTION USE**
>
> This is a prototype implementation demonstrating Okta AI Agent authentication with ID-JAG token exchange. It is intended for learning, testing, and development purposes only. Do not deploy to production environments without proper security review, hardening, and compliance validation.

An Okta-protected AI chatbot that uses **Okta AI Agent Identity** with **ID-JAG (Identity Assertion JWT Authorization Grant)** tokens to securely query the NIST Cybersecurity Framework 2.0.

**This repository includes:**
- 🤖 AI Agent Webapp (main directory)
- 🔧 NIST CSF 2.0 MCP Server (`mcp-server/` directory)

---

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/ivangotti/okta-ai-agent-webapp.git
cd okta-ai-agent-webapp

# 2. Setup everything
npm run setup:all

# 3. Configure environment
cp .env.example .env
# Edit .env with your Okta and LiteLLM credentials

# 4. Start both services
npm run start:both
```

**Access:**
- 🌐 Webapp: http://localhost:3001
- 🔧 MCP Server: http://localhost:8080

---

## What is This?

This application demonstrates **Okta AI Agent architecture** where an AI agent can securely act on behalf of authenticated users.

### Key Concepts

**Two Identities:**
- 👤 **User** (`YOUR_WEBAPP_CLIENT_ID`) - Human authenticating via Okta SSO
- 🤖 **AI Agent** (`YOUR_AGENT_ID`) - AI acting on behalf of user

**Special Token (ID-JAG):**
- Contains BOTH user and agent identity in one cryptographically-signed token
- Enables secure delegation: "Agent X acting for User Y"
- Validated by resource servers (MCP) via Okta's public keys

---

## Features

- ✅ **Okta SSO Authentication** - Users login via OpenID Connect
- ✅ **AI Agent Identity** - Agent has its own Okta identity
- ✅ **ID-JAG Tokens** - Dual-identity tokens per IETF spec
- ✅ **Claude AI Integration** - Powered by Anthropic Claude
- ✅ **MCP Tool Access** - 38 tools to query NIST CSF database
- ✅ **Token Viewer** - Inspect all tokens and their claims
- ✅ **Security** - End-to-end token validation with JWKS

---

## How It Works (The Token Dance)

### Simple Flow

```
1. User logs in → Gets ID Token
2. Agent exchanges ID Token → Gets ID-JAG Token
3. User asks question → Sent to Claude AI
4. Claude decides → "I need MCP data"
5. Agent calls MCP with ID-JAG → Gets NIST data
6. MCP validates ID-JAG → Returns data
7. Claude synthesizes answer from MCP data → User sees response
```

### Three Steps in Detail

#### Step 1: User Authentication 👤

- **Client:** Webapp (`YOUR_WEBAPP_CLIENT_ID` - Web Application)
- **Server:** Okta ORG Authorization Server
- **Endpoint:** `https://your-okta-domain.okta.com/oauth2/v1/authorize`
- **Result:** User ID Token + Access Token

**User ID Token contains:**
```json
{
  "iss": "https://your-okta-domain.okta.com",
  "aud": "YOUR_WEBAPP_CLIENT_ID",
  "sub": "USER_ID_FROM_OKTA",  // User's Okta ID
  "email": "user@example.com",
  "name": "User Name"
}
```

---

#### Step 2: ID-JAG Token Exchange 🤖

- **Client:** AI Agent (`YOUR_AGENT_ID` - AI Agent/Workload)
- **Server:** Okta ORG Authorization Server (**NOT custom server**)
- **Endpoint:** `https://your-okta-domain.okta.com/oauth2/v1/token`
- **Grant:** Token Exchange
- **Auth:** Agent signs JWT with private key (RS256)

**Request to Okta:**
```javascript
POST /oauth2/v1/token

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type=urn:ietf:params:oauth:token-type:id-jag
client_id=YOUR_AGENT_ID
subject_token={User's ID Token}
subject_token_type=urn:ietf:params:oauth:token-type:id_token
audience=https://your-okta-domain.okta.com/oauth2/YOUR_CUSTOM_AUTH_SERVER
scope=ask-nist-mcp
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion={JWT signed with agent's private key}
```

**Okta returns ID-JAG Token:**
```json
{
  "typ": "oauth-id-jag+jwt",
  "iss": "https://your-okta-domain.okta.com",
  "aud": "https://your-okta-domain.okta.com/oauth2/YOUR_CUSTOM_AUTH_SERVER",
  "sub": "USER_ID_FROM_OKTA",         // ← User ID
  "client_id": "YOUR_AGENT_ID",       // ← Agent ID
  "scope": "ask-nist-mcp"
}
```

💡 **Dual Identity:** Token proves "Agent YOUR_AGENT_ID is acting for User USER_ID"

---

#### Step 3: Call MCP Server 🔧

- **Agent → MCP Server**
- **Authorization:** `Bearer {ID-JAG Token}`
- **MCP validates:** Calls Okta JWKS, verifies signature, checks claims
- **MCP knows:** User ID (`sub`) + Agent ID (`client_id`)

---

### Critical Rules

| Rule | Why |
|------|-----|
| **Users MUST login via ORG server** | ID-JAG requires ID tokens from ORG |
| **ID-JAG exchange at ORG server** | Only ORG can issue ID-JAG tokens |
| **Audience = custom server** | Where ID-JAG will be used (but exchange at ORG) |
| **Agent uses private key JWT** | Not client_secret |
| **Scope: ask-nist-mcp** | Must be requested and validated |

---

## Installation & Setup

### Prerequisites

- Node.js 20.x or higher
- Okta organization with AI Agent support
- LiteLLM API access
- Git

### Step 1: Environment Configuration

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description | Example |
|----------|-------------|---------|
| `OKTA_DOMAIN` | Your Okta org | `https://your-org.okta.com` |
| `OKTA_ISSUER` | ORG server issuer | `https://your-org.okta.com` |
| `OKTA_CLIENT_ID` | Webapp OAuth client | `0oa2o8rchw8BvvkEA0h8` |
| `OKTA_CLIENT_SECRET` | Webapp secret | (from Okta) |
| `AGENT_CLIENT_ID` | AI Agent ID | `wlp2o86e2kkTN0tuS0h8` |
| `CUSTOM_AUTH_SERVER` | Custom auth server | `https://your-org.okta.com/oauth2/aus...` |
| `AGENT_PRIVATE_KEY_PATH` | Path to agent JWK | `./agent-keys/agent-private-key.json` |
| `LITELLM_KEY` | LiteLLM API key | (your key) |
| `MCP_SERVER_URL` | MCP endpoint | `http://localhost:8080` |

### Step 2: Install Dependencies

```bash
npm run setup:all
```

This installs dependencies for both webapp and MCP server.

### Step 3: Start Services

```bash
npm run start:both
```

Or start separately:
```bash
# Terminal 1
npm run start:mcp

# Terminal 2
npm start
```

---

## How to Use

1. **Open** http://localhost:3001
2. **Login** with your Okta credentials
3. **Ask questions** about NIST CSF 2.0
4. **Click your name** to view tokens
5. **Click "Connected (38 tools)"** to see MCP tools

### Example Questions

- "What is NIST CSF 2.0?"
- "Look up the GOVERN function"
- "Search for incident response controls"
- "What are the DETECT categories?"
- "Show me access control subcategories"
- "What questions assess risk management?"

---

## Technical Deep Dive

### Architecture

**Component Flow:**
```
User → Webapp → Claude AI → MCP Server
         ↓         ↓           ↓
      Okta SSO  (decides)  NIST DB
                (to use tools)
```

**Authorization Servers:**

| Server | URL | Used For |
|--------|-----|----------|
| **ORG** | `your-okta-domain.okta.com/oauth2/v1` | User login, ID-JAG exchange |
| **Custom** | `your-okta-domain.okta.com/oauth2/aus...` | Audience, scope definition |

### When to Use Which Client ID

| Operation | Client ID | Auth Method |
|-----------|-----------|-------------|
| **User Login** | `YOUR_WEBAPP_CLIENT_ID` | client_secret |
| **ID-JAG Exchange** | `YOUR_AGENT_ID` | private_key_jwt (RS256) |

### Getting an ID-JAG Token

**Endpoint (MUST be ORG server):**
```
POST https://your-okta-domain.okta.com/oauth2/v1/token
```

⚠️ **NOT** `https://your-okta-domain.okta.com/oauth2/aus.../v1/token`

**Agent Authentication (Client Assertion):**

The agent creates a signed JWT to prove its identity:

```json
{
  "header": {
    "alg": "RS256",
    "kid": "agent-key-id"
  },
  "payload": {
    "iss": "YOUR_AGENT_ID",
    "sub": "YOUR_AGENT_ID",
    "aud": "https://your-okta-domain.okta.com/oauth2/v1/token",
    "iat": 1773106644,
    "exp": 1773106944,
    "jti": "unique-uuid"
  }
}
```

Signed with agent's **private RSA key** (NOT client_secret).

**Code:**
```javascript
async function getIdJagToken(userIdToken, userId) {
  // ⚠️ CRITICAL: Exchange MUST happen at ORG authorization server
  const ORG_TOKEN_ENDPOINT = 'https://your-okta-domain.okta.com/oauth2/v1/token';

  // Generate client assertion
  const clientAssertion = generateClientAssertion(
    AGENT_CLIENT_ID,
    ORG_TOKEN_ENDPOINT  // ⚠️ Audience of JWT = token endpoint
  );

  // Token exchange request
  const response = await fetch(ORG_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      client_id: AGENT_CLIENT_ID,
      subject_token: userIdToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      audience: CUSTOM_AUTH_SERVER,  // Where ID-JAG will be used
      scope: 'ask-nist-mcp',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion
    })
  });

  const data = await response.json();
  return data.access_token;  // ID-JAG token
}
```

### MCP Token Validation

The MCP server validates every request:

1. **Extracts** ID-JAG from `Authorization: Bearer {token}`
2. **Fetches** Okta's public keys (JWKS) from `/oauth2/v1/keys`
3. **Verifies** cryptographic signature (proves Okta issued it)
4. **Validates** claims:
   - Expiration (`exp` must be future)
   - Audience (`aud` must match custom server)
   - Issuer (`iss` must be ORG server)
   - **Scope (`scope` must contain `ask-nist-mcp`)**
5. **Extracts** identity:
   - User ID from `sub` claim
   - Agent ID from `client_id` claim
6. **Processes** request with full context

**Security:** Every MCP call is cryptographically authenticated with dual identity verified by Okta.

---

## API Endpoints

### Webapp Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | Required | Chat interface |
| `/login` | GET | - | Okta login |
| `/logout` | GET | - | Logout (clears SSO) |
| `/session-expired` | GET | - | Session expired page |
| `/authorization-code/callback` | GET | - | OAuth callback |
| `/api/user` | GET | - | Current user info |
| `/api/tokens` | GET | Required | User tokens (ID + Access) |
| `/api/agent/tokens` | GET | Required | Agent tokens + ID-JAG |
| `/api/chat` | POST | Required | Send chat message |
| `/api/health` | GET | - | System health check |

### MCP Server Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | - | MCP health check |
| `/api/tools` | GET | - | List all 38 tools |
| `/api/tools/:toolName` | POST | **ID-JAG Required** | Execute MCP tool |

---

## Project Structure

```
okta-ai-agent-webapp/
├── server.js              # Express server with Okta auth
├── public/
│   └── index.html         # Frontend chat UI
├── agent-keys/
│   └── agent-private-key.json  # Agent's private JWK (not in git)
├── package.json           # Webapp dependencies
├── .env                   # Configuration (not in git)
├── .env.example           # Configuration template
├── README.md              # This file
└── mcp-server/            # NIST CSF 2.0 MCP Server
    ├── src/               # TypeScript source
    ├── dist/              # Compiled JavaScript
    ├── data/              # NIST CSF framework data
    ├── scripts/           # Setup scripts
    └── package.json       # MCP dependencies
```

---

## Dependencies

**Webapp:**
- express - Web framework
- passport + passport-openidconnect - Okta SSO
- jsonwebtoken - JWT signing/validation
- dotenv - Environment configuration
- express-session - Session management

**MCP Server:**
- @modelcontextprotocol/sdk - MCP protocol
- better-sqlite3 - Database
- zod - Input validation
- TypeScript - Type safety

---

## Token Viewer

Click your username in the header to see:

### User Tokens (Inbound)
- **ID Token** - User identity from Okta SSO
- **Access Token** - User authorization

### ID-JAG Token (Agent)
- **Dual Identity** - Contains both user and agent
- **Claims visible** - See `sub` (user) and `client_id` (agent)
- **Copyable** - Copy raw JWT for inspection

### Token Flow Diagram
Shows the 3-step process with real client IDs and server URLs.

---

## MCP Tools Viewer

Click **"Connected (38 tools)"** to see:
- MCP server status
- Host and port
- Complete list of 38 NIST CSF tools
- Tool descriptions

---

## Troubleshooting

### "Policy evaluation failed"
- Assign your Okta user to webapp application
- Check authentication policies

### "MCP Server Offline"
- Start MCP: `npm run start:mcp`
- Check port 8080 is available

### "Token exchange failed"
- Verify agent has token-exchange grant enabled
- Check scope `ask-nist-mcp` exists in custom auth server
- Ensure ID token is from ORG server (not custom)

### "Invalid audience"
- Audience must be custom auth server URL
- Check `CUSTOM_AUTH_SERVER` in .env

### Session expired
- Sessions last 24 hours
- Click "Click Here to Log In Again"

### Logout doesn't work
- Logout now clears both local and Okta SSO session
- May need to clear browser cookies

---

## Development

```bash
# Run webapp with auto-reload
npm run dev

# Run with logging
DEBUG=* npm start

# Test ID-JAG exchange
node test-id-jag.js
```

---

## Security Notes

- ✅ All secrets in environment variables
- ✅ Private repository recommended
- ✅ Session secrets should be strong random strings
- ✅ HTTPS required for production
- ✅ Private keys never committed to git
- ✅ ID-JAG tokens validated cryptographically
- ✅ Full audit trail (user + agent in every request)

---

## Technical Reference

### Environment Variables (Complete List)

```bash
# LiteLLM
ANTHROPIC_BASE_URL=https://your-litellm-provider.com
LITELLM_KEY=your-api-key
MODEL=claude-4-5-sonnet

# Okta User Authentication
OKTA_DOMAIN=https://your-org.okta.com
OKTA_ISSUER=https://your-org.okta.com
OKTA_CLIENT_ID=YOUR_WEBAPP_CLIENT_ID
OKTA_CLIENT_SECRET=your-client-secret
OKTA_REDIRECT_URI=http://localhost:3001/authorization-code/callback
OKTA_LOGOUT_REDIRECT_URI=http://localhost:3001

# AI Agent Configuration
AGENT_CLIENT_ID=YOUR_AGENT_ID
AGENT_NAME=NIST CSF 2.0 AI Agent
CUSTOM_AUTH_SERVER=https://your-org.okta.com/oauth2/aus...
MCP_AUDIENCE=api://nist-mcp-server
MCP_SCOPE=ask-nist-mcp
AGENT_PRIVATE_KEY_PATH=./agent-keys/agent-private-key.json

# Server
PORT=3001
MCP_SERVER_URL=http://localhost:8080
SESSION_SECRET=change-this-to-random-string
```

### NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run setup:all` | Install all dependencies (webapp + MCP) |
| `npm run start:both` | Start both services |
| `npm run start:mcp` | Start only MCP server |
| `npm start` | Start only webapp |
| `npm run dev` | Dev mode with auto-reload |

---

## License

MIT License. Part of the NIST CSF 2.0 MCP Server project.

---

## References

- [Okta AI Agent Documentation](https://developer.okta.com/docs/guides/ai-agent-token-exchange/)
- [IETF ID-JAG Spec](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)
- [RFC 8693 - Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- [NIST CSF 2.0](https://www.nist.gov/cyberframework)

# NIST CSF 2.0 AI Chatbot Web Application

> ⚠️ **EXPERIMENTAL CODE - NOT FOR PRODUCTION USE**
>
> This is a prototype implementation demonstrating Okta AI Agent authentication with ID-JAG token exchange. It is intended for learning, testing, and development purposes only. Do not deploy to production environments without proper security review, hardening, and compliance validation.

An Okta-protected AI chatbot that uses **Okta AI Agent Identity** with **ID-JAG (Identity Assertion JWT Authorization Grant)** tokens to securely query the NIST Cybersecurity Framework 2.0.

**This repository includes:**
- 🤖 AI Agent Webapp (main directory)
- 🔧 NIST CSF 2.0 MCP Server (`nist-mcp-server/` directory)
- 🔐 Okta Users MCP Server (`users-mcp-server/` directory) - a second use case demonstrating **PAM-vaulted API keys** (see below)

> 📋 **Note on MCP Server:** This repository includes an open-source implementation of the NIST Cybersecurity Framework 2.0 MCP (Model Context Protocol) server. The MCP server code is based on the open-source project available at [github.com/rocklambros/nist-csf-2-mcp-server](https://github.com/rocklambros/nist-csf-2-mcp-server) (MIT License). It is included here for convenience and demonstration purposes. The NIST Cybersecurity Framework is a public framework published by NIST, and this implementation provides programmatic access to the framework data for educational and development purposes.

> 🔑 **No standing API key.** The `users-mcp-server` use case demonstrates a second, distinct pattern: the AI Agent never holds or caches the Okta API key it needs to call the Okta Users API. Every single time it needs to talk to that resource, it has to ask Okta for one. That key lives securely vaulted in **Okta Privileged Access Manager (PAM)**, and **Okta for AI Agents** wires a PAM connection into the Agent's Okta identity so the agent is authorized to request it. The agent proves who it is with a JWS (a signed JWT), and in exchange Okta hands back a short-lived, single-use vaulted secret - never a long-lived key sitting in `.env`. See [How It Works (Agent Retrieves Secret from PAM)](#how-it-works-agent-retrieves-secret-from-pam) for the full token flow.

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

# 4. Start all three services (webapp + both MCP servers, via concurrently)
npm start
```

**Access:**
- 🌐 Webapp: http://localhost:3001
- 🔧 NIST CSF 2.0 MCP Server: http://localhost:8080
- 🔐 Okta Users MCP Server: http://localhost:8081

---

## What is This?

This application demonstrates **Okta AI Agent architecture** where an AI agent can securely act on behalf of authenticated users, across two distinct use cases:

1. **NIST CSF 2.0 lookups** (`nist-mcp-server`) - the agent exchanges the user's ID token for an **ID-JAG token**, then an **access token**, and uses that access token as a normal Bearer credential against the MCP server. The access token is valid for its full lifetime (1 hour) and can be reused across calls.
2. **Okta user search** (`users-mcp-server`) - the agent holds **no API key at all**. On every call it exchanges the user's raw ID token for a **vaulted secret** pulled live from Okta PAM, uses it exactly once, and discards it. There is nothing long-lived to steal, leak, or rotate.

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
- ✅ **Claude AI Integration** - Powered by Anthropic Claude via LiteLLM
- ✅ **MCP Tool Access** - 38 NIST CSF tools + Okta user search across two independent MCP servers
- ✅ **PAM-Vaulted API Keys** - The agent holds no standing Okta API key; it requests a fresh, short-lived one from Okta Privileged Access Manager on every call (see [`users-mcp-server`](./users-mcp-server/README.md))
- ✅ **Token Viewer** - Inspect all tokens and their claims
- ✅ **Security** - End-to-end token validation with JWKS
- ✅ **MCP Server Status & Tools** - Live dashboard showing both MCP servers, their health, and their available tools

> 💡 **AI Backend:** This project uses [LiteLLM](https://litellm.ai/) as a proxy to Anthropic's Claude API. You can use Anthropic's API directly by changing the environment variables:
> - `ANTHROPIC_BASE_URL` → `https://api.anthropic.com`
> - `LITELLM_KEY` → Your Anthropic API key
>
> The application is compatible with both LiteLLM proxies and direct Anthropic API connections.

---

## How It Works (The Token Dance)

### Simple Flow

```
1. User logs in → Gets ID Token
2. Agent exchanges ID Token → Gets ID-JAG Token (ORG server)
3. Agent exchanges ID-JAG → Gets Access Token (Custom server)
4. User asks question → Sent to Claude AI
5. Claude decides → "I need MCP data"
6. Agent calls MCP with Access Token → Gets NIST data
7. MCP validates Access Token with Custom JWKS → Returns data
8. Claude synthesizes answer from MCP data → User sees response
```

### Complete Token Chain (4 Steps)

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

#### Step 3: Exchange ID-JAG for Access Token 🔑

- **Client:** AI Agent (`YOUR_AGENT_ID`)
- **Server:** Custom Authorization Server
- **Endpoint:** `https://your-okta-domain.okta.com/oauth2/YOUR_CUSTOM_AUTH_SERVER/v1/token`
- **Grant:** `urn:ietf:params:oauth:grant-type:jwt-bearer`
- **Auth:** `private_key_jwt` (RS256)

**Request to Custom Server:**
```javascript
POST /oauth2/YOUR_CUSTOM_AUTH_SERVER/v1/token

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
client_id=YOUR_AGENT_ID
assertion={ID-JAG Token}
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion={Fresh signed JWT for Custom Server}
// NO scope parameter - scope inherited from ID-JAG
```

**Custom Server returns Access Token:**
```json
{
  "token_type": "Bearer",
  "expires_in": 3600,
  "access_token": "eyJhbGc...",
  "scope": "ask-nist-mcp"
}
```

**Access Token Claims:**
```json
{
  "iss": "https://your-okta-domain.okta.com/oauth2/YOUR_CUSTOM_AUTH_SERVER",
  "aud": "api://nist-mcp-server",
  "sub": "user@example.com",
  "cid": "YOUR_AGENT_ID",
  "scp": ["ask-nist-mcp"],
  "uid": "USER_ID_FROM_OKTA"
}
```

⚠️ **Critical:** Do NOT include `scope` parameter in jwt-bearer request - scope comes from ID-JAG

---

#### Step 4: Call MCP Server 🔧

- **Agent → MCP Server**
- **Authorization:** `Bearer {MCP Access Token}`
- **MCP validates:** Calls Custom Server JWKS, verifies signature, checks claims
- **MCP knows:** User ID (`sub`/`uid`) + Agent ID (`cid`) + Scopes (`scp`)

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

## How It Works (Agent Retrieves Secret from PAM)

The `search_users` tool (served by `users-mcp-server`) needs a real Okta API token (`SSWS`) to call the Okta Users API. **The agent does not have that API key.** It isn't stored in `.env`, it isn't cached in memory, and it isn't handed to the agent once and reused - the agent has to ask Okta for it fresh, every single time it needs to talk to the Okta Users API.

That key lives securely vaulted in **Okta Privileged Access Manager (PAM)**, in a managed connection the agent never sees directly. What the agent *does* have is an **Okta for AI Agents** identity that has been granted an integration into that PAM connection - an admin wires up "this Agent identity is allowed to request this specific vaulted secret" once, in Okta, ahead of time. From then on, every time the agent needs the key, it proves who it is with a **JWS** (a JSON Web Signature - a JWT signed with its private key) and presents the calling user's ID token alongside it. Okta validates both, checks the PAM authorization, and returns the secret - short-lived, single-use, and never persisted anywhere by the agent.

This is a **different token-exchange grant** than the MCP Token Dance above, and it happens on every single call, never once and cached.

### Simple Flow

```
1. User already logged in → Agent reuses the User's raw ID Token (same one from Token Dance Step 1)
2. Agent signs a fresh client_assertion (private_key_jwt) → proves agent identity
3. Agent exchanges the User's ID Token → Gets a Vaulted Secret (ORG server, resource = PAM connection ORN)
4. Agent uses the Vaulted Secret as the Okta API token (SSWS header) → Calls Okta Users API
5. Okta Users API returns matching users → Agent returns results to Claude
6. Claude synthesizes an answer from the results → User sees response
```

### Complete Flow (3 Steps)

#### Step 1: Reuse the User's Raw ID Token 👤

- No new login - the raw ID Token from **Token Dance Step 1** is reused directly as the `subject_token` here.
- **Key difference from the Token Dance:** `users-mcp-server` needs the user's raw ID Token itself, not an ID-JAG or Access Token - PAM validates the user's own ID Token directly, it doesn't accept a delegated/downstream token.
- The webapp passes it straight through: `Authorization: Bearer {User's raw ID Token}` when calling `users-mcp-server`.

---

#### Step 2: Token Exchange for a Vaulted Secret 🔐

- **Client:** AI Agent (`YOUR_AGENT_ID` - same identity as the Token Dance)
- **Server:** Okta ORG Authorization Server (same endpoint as the ID-JAG exchange, different grant params)
- **Endpoint:** `https://your-okta-domain.okta.com/oauth2/v1/token`
- **Grant:** Token Exchange
- **Requested token type:** `urn:okta:params:oauth:token-type:vaulted-secret` (⚠️ Okta-namespaced URN, **not** the IETF standard token-type URN - specific to O4AA's vaulted-secret/service-account flows)
- **Resource:** ORN of the PAM-managed connection holding the secret (not an audience/scope like the ID-JAG exchange)
- **Auth:** Agent signs a fresh JWT with its private key (RS256), `aud` = the ORG token endpoint

**Request to Okta:**
```javascript
POST /oauth2/v1/token

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token={User's raw ID Token}
subject_token_type=urn:ietf:params:oauth:token-type:id_token
requested_token_type=urn:okta:params:oauth:token-type:vaulted-secret
resource={ORN of the PAM managed connection}
client_id=YOUR_AGENT_ID
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion={JWT signed with agent's private key}
```

**Okta returns the Vaulted Secret:**
```json
{
  "token_type": "N_A",
  "expires_in": 300,
  "issued_token_type": "urn:okta:params:oauth:token-type:vaulted-secret",
  "vaulted_secret": {
    "apikey": "{the actual Okta API token}",
    "username": null,
    "password": null,
    "host": null
  }
}
```

💡 **Field name depends on connection type:** the O4AA spec describes `vaulted_secret.private`, but an API-key-type PAM connection (this project's setup) actually returns it under `vaulted_secret.apikey` instead. `okta-token-exchange.ts` checks `private` → `apikey` → `password` in that order, so it works regardless of which secret type the PAM connection holds.

⚠️ **5-minute TTL:** `expires_in: 300`. This is exactly why the secret is fetched fresh on every `search_users` call and never cached - it's designed to be short-lived.

---

#### Step 3: Call the Downstream API with the Vaulted Secret 🔧

- **Agent → Okta Users API**
- **Authorization:** `SSWS {vaulted secret}` (Okta's own API key scheme, not `Bearer`)
- One secret, one call, then it's discarded - the *next* `search_users` call repeats Steps 1-3 from scratch, with a brand-new client_assertion and a brand-new vaulted secret.

---

### Critical Rules

| Rule | Why |
|------|-----|
| **subject_token = raw ID Token, not ID-JAG/Access Token** | PAM validates the user's own ID Token directly - it's a different trust path than the MCP Token Dance |
| **requested_token_type is Okta-namespaced (`urn:okta:...`)** | Not the IETF standard URN - specific to O4AA's vaulted-secret/service-account flows |
| **resource = ORN, not audience/scope** | The vaulted-secret exchange targets a specific PAM connection resource, unlike the ID-JAG exchange which targets an audience + scope |
| **Never cache the vaulted secret** | It's short-lived by design (5 min TTL) - fetch fresh on every call |
| **Never log the secret value** | Only the endpoint, resource ORN, and success/failure are logged - the actual key is redacted everywhere in logs and diagnostics |

---

## Installation & Setup

### Prerequisites

- Node.js 20.x or higher
- Okta organization with AI Agent support
- For the `users-mcp-server` use case: a PAM-managed connection holding an Okta API key, with the Agent identity granted an **Okta for AI Agents → PAM** integration authorizing it to request that specific vaulted secret
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
| `MCP_SERVER_URL` | NIST CSF 2.0 MCP endpoint | `http://localhost:8080` |
| `USERS_MCP_SERVER_URL` | Okta Users MCP endpoint | `http://localhost:8081` |

`users-mcp-server` also needs its own `.env` (copy `users-mcp-server/.env.example`) with `VAULTED_SECRET_RESOURCE_ORN` set to the PAM connection's ORN - see [`users-mcp-server/README.md`](./users-mcp-server/README.md#configuration-env) for the full list.

### Step 2: Install Dependencies

```bash
npm run setup:all
```

This installs and builds dependencies for the webapp and **both** MCP servers, and seeds the NIST database.

### Step 3: Start Services

```bash
npm start
```

This runs the webapp, the NIST MCP server, and the Okta Users MCP server concurrently (prefixed `[WEB]`, `[MCP]`, `[USERS]` in the terminal).

Or start any one of them separately:
```bash
npm run start:web         # webapp only, :3001
npm run start:mcp         # NIST CSF 2.0 MCP server only, :8080
npm run start:users-mcp   # Okta Users MCP server only, :8081
```

---

## How to Use

1. **Open** http://localhost:3001
2. **Login** with your Okta credentials
3. **Ask questions** about NIST CSF 2.0, or ask it to look up an Okta user
4. **Click your name** to view tokens
5. **Click the connection status badge** to see both MCP servers and their tools

### Example Questions

- "What is NIST CSF 2.0?"
- "Look up the GOVERN function"
- "Search for incident response controls"
- "What are the DETECT categories?"
- "Find the Okta user with email jane.doe@example.com"
- "Show me access control subcategories"
- "What questions assess risk management?"

---

## Technical Deep Dive

### Architecture

**Component Flow:**
```
                                    ┌─→ NIST CSF 2.0 MCP Server (:8080)
                                    │   Auth: ID-JAG access token (1hr, reusable)
User → Webapp → Claude AI ─(decides)┤
         ↓         ↓        which   │
      Okta SSO  (routes)   tool to  └─→ Okta Users MCP Server (:8081)
                            call        Auth: raw user ID token, exchanged fresh
                                        on every call for a vaulted secret
                                             ↓
                                        Okta PAM (vault) → Okta Users API
```

**Authorization Servers:**

| Server | URL | Used For |
|--------|-----|----------|
| **ORG** | `your-okta-domain.okta.com/oauth2/v1` | User login, ID-JAG exchange, PAM vaulted-secret exchange |
| **Custom** | `your-okta-domain.okta.com/oauth2/aus...` | Audience, scope definition (NIST MCP path only - the PAM path doesn't use it) |

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
| `/api/mcp-servers` | GET | Required | Status + tool inventory for every registered MCP server (drives the "MCP Server Status & Tools" modal) |

### NIST CSF 2.0 MCP Server Endpoints (`nist-mcp-server`, port 8080)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | - | MCP health check |
| `/api/tools` | GET | - | List all 38 tools |
| `/api/tools/:toolName` | POST | **ID-JAG access token required** | Execute MCP tool - reusable Bearer token, valid for its full 1hr lifetime |

### Okta Users MCP Server Endpoints (`users-mcp-server`, port 8081)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | - | MCP health check |
| `/api/tools` | GET | - | List the `search-users` tool |
| `/api/tools/search-users` | POST | **User's raw ID token required** | Search Okta users - the agent exchanges this token for a fresh PAM vaulted secret on every single call; **no API key is ever cached** |

---

## Project Structure

```
okta-ai-agent-webapp/
├── server.js              # Express server with Okta auth
├── public/
│   └── index.html         # Frontend chat UI
├── agent-keys/
│   └── agent-private-key.json  # Agent's private JWK (not in git) - shared by both MCP servers
├── package.json           # Webapp dependencies + concurrently orchestration for all 3 services
├── .env                   # Configuration (not in git)
├── .env.example           # Configuration template
├── README.md              # This file
├── nist-mcp-server/       # NIST CSF 2.0 MCP Server (ID-JAG access token auth)
│   ├── src/               # TypeScript source
│   ├── dist/              # Compiled JavaScript
│   ├── data/              # NIST CSF framework data
│   ├── scripts/           # Setup scripts
│   └── package.json       # MCP dependencies
└── users-mcp-server/      # Okta Users MCP Server (PAM vaulted-secret auth - no standing API key)
    ├── src/               # TypeScript source
    ├── dist/              # Compiled JavaScript
    ├── README.md          # Full vaulted-secret token-exchange details
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

**NIST CSF 2.0 MCP Server:**
- @modelcontextprotocol/sdk - MCP protocol
- better-sqlite3 - Database
- zod - Input validation
- TypeScript - Type safety

**Okta Users MCP Server:**
- @modelcontextprotocol/sdk - MCP protocol
- jsonwebtoken - Decode/inspect the raw user ID token
- helmet + express-rate-limit - HTTP hardening
- zod - Input validation
- winston - Logging (secret values always redacted)
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

## MCP Server Status & Tools

Click the connection status badge to see a card for **every registered MCP server** (`nist-mcp-server` and `users-mcp-server`):
- Online/offline status and health
- Host and port
- Complete tool list per server, with descriptions
- Any error, if a server is unreachable

Adding a third MCP server later needs no frontend changes - just register it in `MCP_SERVERS` in `server.js` and it shows up here automatically.

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

### `search_users` fails / "Users MCP Server" shows offline in the status modal
- Start it: `npm run start:users-mcp` - check port 8081 is available
- Check `USERS_MCP_SERVER_URL` in the webapp's `.env` matches where it's actually running

### Vaulted-secret exchange failed (e.g. "invalid resource" or "unauthorized_client")
- Confirm the Agent identity has an active **Okta for AI Agents → PAM** integration granting it access to the specific managed connection - this is configured once in Okta, ahead of time, and is what authorizes the agent to request the key at all
- Check `VAULTED_SECRET_RESOURCE_ORN` in `users-mcp-server/.env` matches the PAM connection's actual ORN
- Remember: the subject_token here must be the user's **raw ID token**, not an ID-JAG or access token - PAM validates it directly

### "MCP Server Status & Tools" modal shows `Error: Server error: 401`
- This means your webapp login session expired, not that a downstream MCP server is down - re-login and it will resolve

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
- ✅ No standing Okta API key for `users-mcp-server` - a fresh, short-lived vaulted secret is requested from Okta PAM on every `search_users` call and is never cached or persisted
- ✅ Vaulted secret values are never logged - only the endpoint, resource ORN, and success/failure are recorded

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
USERS_MCP_SERVER_URL=http://localhost:8081
SESSION_SECRET=change-this-to-random-string
```

> `users-mcp-server` has its own `.env` (see [`users-mcp-server/README.md`](./users-mcp-server/README.md#configuration-env)) with the PAM-specific variables - notably `VAULTED_SECRET_RESOURCE_ORN`, the ORN of the PAM-managed connection that holds the Okta API key. It reuses the same `AGENT_CLIENT_ID` and `AGENT_PRIVATE_KEY_PATH` as the webapp - one Agent identity, used for both the ID-JAG dance and the PAM vaulted-secret exchange.

### NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run setup:all` | Install dependencies for the webapp + both MCP servers, build both, and seed the NIST database |
| `npm start` | Start all three services concurrently: webapp (`:3001`), NIST MCP server (`:8080`), Users MCP server (`:8081`) |
| `npm run start:web` | Start only the webapp |
| `npm run start:mcp` | Start only the NIST CSF 2.0 MCP server |
| `npm run start:users-mcp` | Start only the Okta Users MCP server |
| `npm run dev` | Dev mode - webapp only, with auto-reload |
| `npm run setup:mcp` | Install, build, and seed only the NIST MCP server |
| `npm run setup:users-mcp` | Install and build only the Users MCP server |

---

## License

MIT License.

### Attributions

- **AI Agent Webapp:** Original implementation demonstrating Okta AI Agent authentication (MIT License)
- **NIST CSF 2.0 MCP Server:** Based on the open-source project by [rocklambros/nist-csf-2-mcp-server](https://github.com/rocklambros/nist-csf-2-mcp-server) (MIT License)
- **NIST Cybersecurity Framework:** Public framework published by [NIST](https://www.nist.gov/cyberframework)

This project is for educational and demonstration purposes. The NIST Cybersecurity Framework data is publicly available and this implementation provides programmatic access following the Model Context Protocol (MCP) specification.

---

## References

- [Okta AI Agent Documentation](https://developer.okta.com/docs/guides/ai-agent-token-exchange/)
- [IETF ID-JAG Spec](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)
- [RFC 8693 - Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- [NIST CSF 2.0](https://www.nist.gov/cyberframework)

---

## Author

**Ivan Gotti**
- Email: ivangotti@gmail.com
- GitHub: [@ivangotti](https://github.com/ivangotti)

Built with assistance from Claude (Anthropic).

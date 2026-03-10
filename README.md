# NIST CSF 2.0 Chatbot Web Application

> ⚠️ **EXPERIMENTAL CODE - NOT FOR PRODUCTION USE**
>
> This is a prototype implementation demonstrating Okta AI Agent authentication with ID-JAG token exchange. It is intended for learning, testing, and development purposes only. Do not deploy to production environments without proper security review, hardening, and compliance validation.

A secure, Okta-protected web chatbot for interacting with the NIST Cybersecurity Framework 2.0 via AI.

## Overview

This standalone web application provides a chat interface to interact with the NIST CSF 2.0 framework using Claude AI. It implements **Okta AI Agent Identity** with ID-JAG (Identity Assertion JWT Authorization Grant) token exchange, allowing an AI agent to act on behalf of authenticated users.

## The Token Dance Explained

This application uses a sophisticated **dual-identity token flow** combining user authentication with AI agent authorization.

### Two Identities, Two Client IDs

| Identity | Client ID | Type | Purpose |
|----------|-----------|------|---------|
| **Webapp (User Auth)** | `YOUR_WEBAPP_CLIENT_ID` | Web Application | Authenticates human users via Okta SSO |
| **AI Agent** | `YOUR_AGENT_ID` | AI Agent (Workload) | Acts on behalf of users to call APIs |

### Complete Token Flow (Step-by-Step)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: User Authentication (Inbound)                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│ Client:   Webapp (YOUR_WEBAPP_CLIENT_ID)                                     │
│ Server:   ORG Authorization Server                                           │
│ Endpoint: https://your-okta-domain.okta.com/oauth2/v1/authorize             │
│ Grant:    authorization_code                                                 │
│ Result:   User ID Token + Access Token                                       │
│                                                                               │
│ User ID Token Claims:                                                        │
│   iss: "https://your-okta-domain.okta.com"                                  │
│   aud: "YOUR_WEBAPP_CLIENT_ID"                                               │
│   sub: "USER_ID_FROM_OKTA"  (Okta user ID)                                  │
│   email: "user@example.com"                                                  │
│   name: "User Name"                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
                                       ↓
                                 User ID Token
                                       ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: ID-JAG Token Exchange (Agent Identity Assertion)                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│ Client:   AI Agent (YOUR_AGENT_ID)                                           │
│ Server:   ORG Authorization Server                                           │
│ Endpoint: https://your-okta-domain.okta.com/oauth2/v1/token                 │
│ Grant:    urn:ietf:params:oauth:grant-type:token-exchange                   │
│ Auth:     private_key_jwt (RS256)                                            │
│                                                                               │
│ Request Parameters:                                                           │
│   grant_type: "urn:ietf:params:oauth:grant-type:token-exchange"             │
│   requested_token_type: "urn:ietf:params:oauth:token-type:id-jag"           │
│   subject_token: {User's ID Token}                                           │
│   subject_token_type: "urn:ietf:params:oauth:token-type:id_token"           │
│   audience: "https://your-okta-domain.okta.com/oauth2/YOUR_CUSTOM_..."      │
│   scope: "ask-nist-mcp"                                                      │
│   client_id: "YOUR_AGENT_ID"                                                 │
│   client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:..."  │
│   client_assertion: {JWT signed with agent's private key}                    │
│                                                                               │
│ Result: ID-JAG Token (oauth-id-jag+jwt)                                      │
│                                                                               │
│ ID-JAG Token Claims (Dual Identity):                                         │
│   typ: "oauth-id-jag+jwt"                                                    │
│   iss: "https://your-okta-domain.okta.com"                                  │
│   aud: "https://your-okta-domain.okta.com/oauth2/YOUR_CUSTOM_..."           │
│                                                                               │
│   sub: "USER_ID_FROM_OKTA"          ← Okta User ID (who needs help)         │
│   client_id: "YOUR_AGENT_ID"        ← AI Agent ID (who is acting)           │
│                                                                               │
│   scope: "ask-nist-mcp"                                                      │
│   jti: "IDAAG.MUJyYv54I3poALLV3lwKA6uw3P51mWXhTO7VYFrbG_A"                   │
│                                                                               │
│   💡 KEY: The ID-JAG encodes BOTH identities in a single token:              │
│      • "sub" claim = Okta user ID (the person being helped)                  │
│      • "client_id" claim = AI agent ID (the agent doing the work)            │
│      This enables full audit trails and fine-grained access policies.        │
└──────────────────────────────────────────────────────────────────────────────┘
                                       ↓
                                 ID-JAG Token
                                       ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Call MCP Server (Outbound)                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│ Agent → MCP Server                                                           │
│ Authorization: Bearer {ID-JAG Token}                                         │
│                                                                               │
│ MCP server validates:                                                        │
│   - Token signature (from ORG server's JWKS)                                 │
│   - Token audience matches its auth server                                   │
│   - Scope includes required permissions                                      │
│   - Token not expired                                                        │
│                                                                               │
│ MCP knows:                                                                   │
│   - User identity from "sub" claim                                           │
│   - Agent identity from "client_id" claim                                    │
│   - Granted scopes from "scope" claim                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### When to Use Which Server

| Action | Server | Endpoint | Why |
|--------|--------|----------|-----|
| **User Login** | ORG | `/oauth2/v1/authorize` | Users authenticate at org level |
| **Get User Tokens** | ORG | `/oauth2/v1/token` | Exchange auth code for tokens |
| **ID-JAG Exchange** | ORG | `/oauth2/v1/token` | Only ORG can issue ID-JAG tokens |
| **Validate ID-JAG** | ORG | `/oauth2/v1/keys` | Get JWKS to verify signature |
| **Call MCP** | Custom | `localhost:8080` | MCP validates with custom server audience |

### When to Use Which Client ID

| Operation | Client ID | Client Secret / Key | Authentication Method |
|-----------|-----------|---------------------|----------------------|
| **User Login** | `YOUR_WEBAPP_CLIENT_ID` | Client Secret | `client_secret_post` |
| **ID-JAG Exchange** | `YOUR_AGENT_ID` | Private JWK | `private_key_jwt` (RS256) |

### Critical Rules

1. **Users MUST authenticate via ORG server** - ID-JAG requires ID tokens from ORG
2. **Agent exchanges at ORG server** - Only ORG can issue ID-JAG tokens
3. **Audience points to custom server** - Where the ID-JAG will be used
4. **Scope must be defined in custom server** - But requested during ORG exchange
5. **Agent uses JWT Bearer assertion** - Not client_secret

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      WEBAPP (This Project)                                │
│                         localhost:3001                                    │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐        │
│  │ Web Browser │───▶│ Express Server   │───▶│ AI Agent Module  │        │
│  │             │    │                  │    │                  │        │
│  │ - Chat UI   │    │ - Session Mgmt   │    │ - Token Exchange │        │
│  │ - Tokens    │    │ - Client ID:     │    │ - Agent ID:      │        │
│  │             │    │   YOUR_WEBAPP... │    │   YOUR_AGENT...  │        │
│  └─────────────┘    └────────┬─────────┘    │ - Private Key    │        │
│                               │              └──────────────────┘        │
│                ┌──────────────┴──────────────┐                           │
│                │                             │                            │
│                ▼                             ▼                            │
│      ┌──────────────────┐         ┌──────────────────┐                   │
│      │   LiteLLM API    │         │  MCP HTTP API    │                   │
│      │                  │         │                  │                   │
│      │  Claude Sonnet   │         │  38 NIST Tools   │                   │
│      │  your-litellm... │         │  localhost:8080  │                   │
│      └──────────────────┘         └──────────────────┘                   │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              │ OAuth 2.0 / OIDC + ID-JAG
                              │
          ┌───────────────────┴───────────────────┐
          │                                       │
          ▼                                       ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Okta ORG Auth Server     │        │ Okta Custom Auth Server  │
│                          │        │                          │
│ your-okta-domain.okta    │        │ .../oauth2/YOUR_CUSTOM   │
│ .com/oauth2/v1           │        │                          │
│                          │        │ Purpose:                 │
│ Used for:                │        │ - Audience definition    │
│ ──────────────────────   │        │ - Scope: ask-nist-mcp    │
│ 1. User Login            │        │ - API: api://nist-mcp    │
│    Client: YOUR_WEBAPP..│        │                          │
│    → ID Token            │        │ NOT used for:            │
│    → Access Token        │        │ - User authentication    │
│                          │        │ - Token exchange         │
│ 2. ID-JAG Exchange       │        │                          │
│    Agent: YOUR_AGENT...  │        │ (Only target audience)   │
│    Subject: User ID Token│        │                          │
│    → ID-JAG Token        │        └──────────────────────────┘
│                          │
│ 3. Token Validation      │
│    JWKS: /oauth2/v1/keys │
│                          │
└──────────────────────────┘
```

## Features

- **Okta SSO Authentication** - Secure login via OpenID Connect
- **AI-Powered Chat** - Claude Sonnet via LiteLLM proxy
- **Token Inspector** - Click username to view parsed ID/Access tokens
- **Session Management** - Secure cookie-based sessions (24hr expiry)
- **Responsive UI** - Modern dark-themed chat interface
- **Real-time Status** - MCP server connection indicator

## Project Structure

```
webapp/
├── server.js              # Express server with Okta auth & API routes
├── package.json           # Dependencies and scripts
├── README.md              # This file
└── public/
    └── index.html         # Single-page chat application
```

### File Descriptions

| File | Description |
|------|-------------|
| `server.js` | Main Express server handling authentication, session management, and API proxying |
| `public/index.html` | Frontend SPA with chat UI, token modal, and authentication flow |
| `package.json` | Node.js dependencies (express, passport, passport-openidconnect) |

## Prerequisites

- **Node.js** 20.x or higher
- **MCP HTTP Server** running on port 8080 (see parent project)
- **Okta Application** configured for OIDC
- **LiteLLM API** access with valid API key

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_BASE_URL` | LiteLLM proxy URL | `https://your-litellm-provider.com` |
| `LITELLM_KEY` | LiteLLM API key | Required |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Claude model name | `claude-4-5-sonnet` |
| `MCP_SERVER_URL` | MCP HTTP server URL | `http://localhost:8080` |
| `PORT` | Webapp server port | `3001` |

### Okta Configuration

**All secrets are now in environment variables** (`.env` file).

Configure these in your `.env` file:

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `OKTA_DOMAIN` | Your Okta domain | Yes |
| `OKTA_ISSUER` | Auth server (use `/oauth2/default` for ID-JAG) | Yes |
| `OKTA_CLIENT_ID` | Webapp OAuth client ID | Yes |
| `OKTA_CLIENT_SECRET` | Webapp client secret | Yes |
| `OKTA_REDIRECT_URI` | OAuth callback URL | Yes |
| `AGENT_CLIENT_ID` | AI agent client ID | Yes |
| `CUSTOM_AUTH_SERVER` | Custom auth server URL (target for ID-JAG) | Yes |
| `AGENT_PRIVATE_KEY_PATH` | Path to agent's JWK private key | Yes |

**Scopes:** `openid profile email`

**⚠️ Security:** Never commit `.env` or secrets to version control!

## Installation

### 1. Setup Environment Variables

```bash
cd webapp

# Copy the example environment file
cp .env.example .env

# Edit .env with your actual credentials
nano .env  # or use your preferred editor
```

**Required Environment Variables:**
| Variable | Description | Example |
|----------|-------------|---------|
| `OKTA_DOMAIN` | Your Okta domain | `https://your-domain.okta.com` |
| `OKTA_ISSUER` | Auth server for user login | `https://your-domain.okta.com/oauth2/default` |
| `OKTA_CLIENT_ID` | Webapp client ID | `YOUR_WEBAPP_CLIENT_ID` |
| `OKTA_CLIENT_SECRET` | Webapp client secret | (from Okta app settings) |
| `AGENT_CLIENT_ID` | AI agent client ID | `YOUR_AGENT_ID` |
| `CUSTOM_AUTH_SERVER` | Custom auth server URL | `https://your-domain.okta.com/oauth2/aus123...` |
| `LITELLM_KEY` | LiteLLM API key | (your API key) |
| `SESSION_SECRET` | Session encryption secret | (random string) |

**⚠️ Security:** Never commit `.env` to version control!

### 2. Install Dependencies

```bash
npm install
```

## Usage

### 1. Start the MCP HTTP Server (Required)

```bash
# From the parent nist-csf-2-mcp-server directory
npm run start:http
```

### 2. Start the Webapp

```bash
cd webapp
npm start
```

### 3. Access the Application

Open **http://localhost:3001** in your browser. You'll be redirected to Okta for authentication.

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | Required | Main chat interface (redirects to /login if not authenticated) |
| `/login` | GET | - | Initiates Okta OIDC login flow |
| `/logout` | GET | - | Logs out and redirects to Okta logout |
| `/authorization-code/callback` | GET | - | Okta OAuth callback handler |
| `/login-error` | GET | - | Displays authentication errors |
| `/api/user` | GET | - | Returns current user info (or null) |
| `/api/tokens` | GET | Required | Returns raw and parsed JWT tokens |
| `/api/health` | GET | - | Health check for MCP and LLM services |
| `/api/chat` | POST | Required | Sends messages to Claude AI |
| `/api/tools` | GET | Required | Lists available MCP tools |

## Token Inspection

Click on your username in the header to view:

- **ID Token** (OpenID Connect)
  - User identity claims (sub, name, email)
  - Authentication metadata (iss, aud, iat, exp)

- **Access Token** (OAuth 2.0)
  - Authorization claims (scp, groups)
  - Token metadata

Both tokens show:
- Raw JWT string (copyable)
- Parsed claims table with formatted timestamps

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^4.18.2 | Web framework |
| express-session | ^1.19.0 | Session management |
| passport | ^0.7.0 | Authentication middleware |
| passport-openidconnect | ^0.1.2 | Okta OIDC strategy |
| cors | ^2.8.5 | CORS middleware |

## Troubleshooting

### "Policy evaluation failed" Error
- Ensure your Okta user is assigned to the application
- Check Okta authentication policies

### "MCP Server Offline" Status
- Start the MCP HTTP server: `npm run start:http` (from parent directory)

### Session Expired
- Sessions last 24 hours; re-login required after expiry

### Chat Returns 500 Error
- Verify `LITELLM_KEY` environment variable is set
- Check LiteLLM proxy is accessible

## Development

```bash
# Run with auto-reload
npm run dev
```

## Security Notes

- Session secret should be changed in production
- Enable `secure: true` for cookies in production (HTTPS)
- Client secret should be moved to environment variables in production
- Tokens are stored in server-side sessions, not client-side

## License

Part of the NIST CSF 2.0 MCP Server project.

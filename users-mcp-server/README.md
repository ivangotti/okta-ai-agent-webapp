# Okta Users MCP Server

Model Context Protocol server exposing one tool, `search-users`, which searches Okta's
[List Users](https://developer.okta.com/docs/api/openapi/okta-management/management/tags/user/other/listusers)
API by first name, last name, and/or email.

> 🔑 **The agent does not have an API key.** Unlike a typical integration where a service
> holds a static API credential, this agent has none - not in `.env`, not cached in memory,
> not issued once and reused. Every single time it needs to call the Okta Users API, it has
> to ask Okta for the key. That key is securely vaulted in **Okta Privileged Access Manager
> (PAM)**, and **Okta for AI Agents** wires a PAM integration into the Agent's Okta identity
> so it's authorized to request it. The agent proves its identity with a **JWS** (a signed
> JWT), and in return gets back a short-lived, single-use vaulted secret - never a
> long-lived key it could leak or need to rotate.

## Why this server is different from `nist-mcp-server`

Calling the Okta Users API requires a live Okta API token (`SSWS`). That token is not a
static secret in `.env` - it's fetched on **every call** from Okta's Privileged Access
vault via an O4AA token exchange:

```
POST {OKTA_DOMAIN}/oauth2/v1/token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token={the calling user's raw Okta ID token}
subject_token_type=urn:ietf:params:oauth:token-type:id_token
requested_token_type=urn:okta:params:oauth:token-type:vaulted-secret
resource={VAULTED_SECRET_RESOURCE_ORN}
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion={JWT signed with the agent's private key}
```

The response's `vaulted_secret.private` is the `SSWS` token used for the Users API call.
This is not cached - a fresh vaulted secret is retrieved for every `search-users` call.

Because the exchange needs the user's **raw** ID token as `subject_token`, the HTTP API
below expects that raw ID token as the Bearer credential (not an ID-JAG/MCP-access token
like `nist-mcp-server` expects).

## Setup

```bash
cd users-mcp-server
npm install
cp .env.example .env   # already pre-filled in this repo; edit if your org differs
npm run build
npm run start:http      # HTTP REST API on port 8081
```

## Modes

| Mode | Command | Port | Use Case |
|------|---------|------|----------|
| HTTP REST API | `npm run start:http` | 8081 | Used by the webapp (`server.js`) |
| MCP stdio | `npm start` | - | Generic MCP clients (e.g. Claude Desktop). Since stdio has no per-request auth header, pass `user_id_token` as a tool argument. |

## Configuration (`.env`)

| Variable | Description |
|---|---|
| `OKTA_DOMAIN` | Okta org base URL, e.g. `https://blackcastle.oktapreview.com` |
| `OKTA_ISSUER` | Expected issuer for incoming ID tokens (light sanity check only) |
| `AGENT_CLIENT_ID` | Same agent client ID used by the webapp (`server.js`) |
| `AGENT_PRIVATE_KEY_PATH` | Path to the agent's private key JWK, relative to this project - defaults to `../agent-keys/agent-private-key.json` (reuses the webapp's key, no duplication) |
| `VAULTED_SECRET_RESOURCE_ORN` | ORN of the PAM managed connection holding the Okta API token |
| `HTTP_PORT` | Port for the HTTP REST server (default `8081`) |

## Usage with Webapp

The webapp calls `POST /api/tools/search-users` with `Authorization: Bearer <user's raw ID token>`:

```bash
curl -X POST http://localhost:8081/api/tools/search-users \
  -H "Authorization: Bearer $USER_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "jane.doe@example.com"}'
```

Response:

```json
{
  "success": true,
  "data": {
    "success": true,
    "count": 1,
    "users": [
      { "id": "00u...", "status": "ACTIVE", "firstName": "Jane", "lastName": "Doe", "email": "jane.doe@example.com", "login": "jane.doe@example.com" }
    ]
  },
  "timestamp": "2026-07-16T00:00:00.000Z",
  "tool": "search-users"
}
```

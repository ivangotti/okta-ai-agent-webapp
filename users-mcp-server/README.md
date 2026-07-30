# Users MCP Server

Model Context Protocol server exposing two tools:

- **`search-users`** - searches Okta's [List Users](https://developer.okta.com/docs/api/openapi/okta-management/management/tags/user/other/listusers) API by first name, last name, and/or email.
- **`get-salesforce-service-account`** - retrieves a Salesforce service-account credential vaulted in Okta PAM, then logs into Salesforce with it.

Both tools are fronted by the same **Agent-to-Agent (A2A) delegation chain** before their respective PAM exchange runs - see [Agent-to-Agent (A2A) Delegation Chain](#agent-to-agent-a2a-delegation-chain) below.

> 🔑 **The agent does not have an API key.** Unlike a typical integration where a service
> holds a static API credential, this agent has none - not in `.env`, not cached in memory,
> not issued once and reused. Every single time it needs to call the Okta Users API (or
> Salesforce), it has to ask Okta for the credential. That credential is securely vaulted in
> **Okta Privileged Access Manager (PAM)**, and **Okta for AI Agents** wires a PAM
> integration into the Agent's Okta identity so it's authorized to request it. The agent
> proves its identity with a **JWS** (a signed JWT), and in return gets back a short-lived,
> single-use vaulted credential - never a long-lived one it could leak or need to rotate.

## Why this server is different from `nist-mcp-server`

Calling the Okta Users API requires a live Okta API token (`SSWS`). That token is not a
static secret in `.env` - it's fetched on **every call** from Okta's Privileged Access
vault via an O4AA token exchange:

```
POST {OKTA_DOMAIN}/oauth2/v1/token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token={the A2A-chained access token, T3 - see below}
subject_token_type=urn:ietf:params:oauth:token-type:access_token
requested_token_type=urn:okta:params:oauth:token-type:vaulted-secret
resource={VAULTED_SECRET_RESOURCE_ORN}
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion={JWT signed with Agent B's private key}
```

The response's `vaulted_secret.apikey` (checked in that order against `.private`/`.password`
too, since the exact field name depends on the PAM connection type) is the `SSWS` token used
for the Users API call. This is not cached - a fresh vaulted secret is retrieved for every
`search-users` call.

Because the *original* subject_token (before A2A delegation) needs to be the user's **raw**
ID token, the HTTP API below expects that raw ID token as the Bearer credential (not an
ID-JAG/MCP-access token like `nist-mcp-server` expects).

## Agent-to-Agent (A2A) Delegation Chain

Both tools first run a two-hop ID-JAG delegation (`agent-a2a-chain.ts`) before doing their
own PAM exchange:

1. **Agent A** (this server's primary identity, `AGENT_CLIENT_ID`) trades the caller's raw
   ID token for an **ID-JAG** scoped to **Agent B** (`AGENT_B_CLIENT_ID`) - a token exchange
   at Okta's ORG server, signed with Agent A's private key.
2. Agent A redeems that ID-JAG at **Agent B's Custom Authorization Server** via `jwt-bearer`
   (still signed with Agent A's key - the redeeming party authenticates as Agent A). The
   result is a real access token ("**T3**").

T3's top-level `sub` is still the human caller; its `act` claim names Agent A as the actor
who obtained it. T3 is then handed to the vaulted-secret / service-account exchange as
`subject_token` (`subject_token_type=access_token`), this time signed with **Agent B's**
private key (`AGENT_B_PRIVATE_KEY_PATH`) - so the eventual PAM credential is retrieved by
Agent B, with the full chain of custody (user → Agent A → Agent B) provable from T3's claims
alone. There is no `actor_token` anywhere in this chain by design.

This runs fresh on every tool call, same as the PAM exchanges downstream of it - nothing is
cached. `okta-token-exchange.ts` and `okta-service-account-exchange.ts` both accept an
optional `{ subjectTokenType, clientId, privateKeyPath }` so they can be called either the
original way (Agent A, raw ID token) or with the A2A chain's output (Agent B, T3) - both
tools in this server use the latter.

**Setup prerequisites**, configured once in Okta ahead of time:
- Agent B registered and activated as its own AI Agent identity
- A delegation link Agent A → Agent B
- A managed connection (`IDENTITY_ASSERTION_A2A_SERVER`) from Agent A to Agent B's Custom AS
- Agent B's own `Okta for AI Agents → PAM` integration authorizing it to request the
  downstream vaulted secret / service account

## `get-salesforce-service-account`

Requests a Salesforce username/password vaulted in PAM (a different O4AA resource type -
`service-account` - than `search-users`'s `vaulted-secret`):

```
POST {OKTA_DOMAIN}/oauth2/v1/token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token={the A2A-chained access token, T3}
subject_token_type=urn:ietf:params:oauth:token-type:access_token
requested_token_type=urn:okta:params:oauth:token-type:service-account
resource={SERVICE_ACCOUNT_RESOURCE_ORN}
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion={JWT signed with Agent B's private key}
```

Okta's response carries `service_account: { username, password }` - not a bearer token or
API key. Salesforce doesn't accept that pair directly as an API credential, so
`salesforce-login.ts` performs one more, entirely non-Okta hop: Salesforce's own OAuth 2.0
**password grant** (`POST {SALESFORCE_LOGIN_URL}/services/oauth2/token`) using a Salesforce
Connected App (`SALESFORCE_CLIENT_ID`/`SALESFORCE_CLIENT_SECRET`) plus the PAM-retrieved
username/password. That second hop is optional and gated: if the Connected App isn't
configured, the tool still reports the PAM retrieval as a success and simply marks
`salesforceLogin.attempted: false` rather than failing outright.

Nothing here is cached - a fresh service-account credential (and a fresh Salesforce login,
if configured) is fetched on every call.

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
| MCP stdio | `npm start` | - | Generic MCP clients (e.g. Claude Desktop). Since stdio has no per-request auth header, pass `user_id_token` as a tool argument for either tool. |

## Configuration (`.env`)

| Variable | Description |
|---|---|
| `OKTA_DOMAIN` | Okta org base URL, e.g. `https://blackcastle.oktapreview.com` |
| `OKTA_ISSUER` | Expected issuer for incoming ID tokens (light sanity check only) |
| `AGENT_CLIENT_ID` | Agent A's client ID - same agent identity used by the webapp (`server.js`), the front door that receives the caller's raw ID token and initiates A2A delegation |
| `AGENT_PRIVATE_KEY_PATH` | Path to Agent A's private key JWK, relative to this project - defaults to `../agent-keys/agent-private-key.json` (reuses the webapp's key, no duplication) |
| `AGENT_B_CLIENT_ID` | Agent B's client ID - the second AI Agent identity that ultimately performs the PAM exchange (see [A2A Delegation Chain](#agent-to-agent-a2a-delegation-chain)) |
| `AGENT_B_PRIVATE_KEY_PATH` | Path to Agent B's private key JWK, relative to this project |
| `AGENT_B_RESOURCE_URL` | Agent B's registered `resourceUrl` (`workload-principals/api/v1/ai-agents`) - the `resource` param for the ID-JAG requested in A2A hop 1 |
| `AGENT_B_AUTH_SERVER_ID` | Custom Authorization Server ID fronting Agent B (linked to it via `resource-servers/api/v1/a2a-servers/{agentBId}/authorization-servers`) - builds the audience for hop 1 and the token endpoint for hop 1's redemption |
| `AGENT_B_SCOPE` | Scope granted by Agent B's Custom AS policy for `client_credentials` + `jwt-bearer` (default `agent.invoke`) |
| `VAULTED_SECRET_RESOURCE_ORN` | ORN of the PAM managed connection holding the Okta API token, for `search-users` |
| `SERVICE_ACCOUNT_RESOURCE_ORN` | ORN of the PAM-managed Salesforce service account, for `get-salesforce-service-account` |
| `SALESFORCE_LOGIN_URL` | Salesforce login base URL, e.g. `https://login.salesforce.com` (optional - see below) |
| `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` | Salesforce Connected App credentials, used only for the downstream OAuth password-grant login in `get-salesforce-service-account`. Optional - if unset, that tool still succeeds at the PAM retrieval and simply skips the Salesforce login |
| `HTTP_PORT` | Port for the HTTP REST server (default `8081`) |

## Usage with Webapp

The webapp calls both tool endpoints with `Authorization: Bearer <user's raw ID token>`.

### `search-users`

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
    ],
    "a2aChain": { "agentAClientId": "...", "agentBClientId": "...", "hop1": { "...": "..." }, "chainedAccessTokenClaims": { "sub": "00u...", "act": { "sub": "..." } } },
    "pamExchange": { "tokenEndpoint": "...", "resource": "...", "rawResponseRedacted": { "vaulted_secret": { "apikey": "REDACTED" } } }
  },
  "timestamp": "2026-07-16T00:00:00.000Z",
  "tool": "search-users"
}
```

### `get-salesforce-service-account`

```bash
curl -X POST http://localhost:8081/api/tools/get-salesforce-service-account \
  -H "Authorization: Bearer $USER_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response:

```json
{
  "success": true,
  "data": {
    "success": true,
    "username": "svc-salesforce@example.com",
    "salesforceLogin": { "attempted": true, "loggedIn": true, "instanceUrl": "https://your-instance.my.salesforce.com" },
    "a2aChain": { "agentAClientId": "...", "agentBClientId": "...", "chainedAccessTokenClaims": { "sub": "00u...", "act": { "sub": "..." } } },
    "pamExchange": { "tokenEndpoint": "...", "resource": "...", "rawResponseRedacted": { "service_account": { "username": "svc-salesforce@example.com", "password": "REDACTED" } } }
  },
  "timestamp": "2026-07-16T00:00:00.000Z",
  "tool": "get-salesforce-service-account"
}
```

Neither response ever includes the real vaulted secret or password - only redacted metadata.
Local debugging endpoints (unauthenticated aside from the same raw-ID-token header, intended
for the webapp's "DEBUG" reveal button only) expose the real values when needed:

| Endpoint | Reveals |
|---|---|
| `GET /api/debug/reveal-secret` | The real vaulted secret from the most recent `search-users` call |
| `GET /api/debug/reveal-service-account` | The real username/password from the most recent `get-salesforce-service-account` call |
| `GET /api/debug/reveal-a2a-chain` | The raw ID-JAG and chained access token (T3) from the most recent A2A chain run |

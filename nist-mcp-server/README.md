# NIST CSF 2.0 MCP Server

Model Context Protocol server providing 38 tools for NIST Cybersecurity Framework 2.0.

## Setup

```bash
cd nist-mcp-server

# Install dependencies
npm install

# Build TypeScript
npm run build

# Initialize database
npm run import:csf-framework
npm run seed:questions

# Start HTTP server
npm run start:http  # Port 8080
```

## Modes

| Mode | Command | Port | Use Case |
|------|---------|------|----------|
| HTTP REST API | `npm run start:http` | 8080 | For webapp and HTTP clients |
| MCP stdio | `npm start` | - | For Claude Desktop |

## Features

- 38 MCP tools for NIST CSF 2.0
- SQLite database with framework data
- 6 functions, 34 categories, 185 subcategories
- 740 assessment questions

## Usage with Webapp

The AI Agent webapp (parent directory) connects to this MCP server via HTTP.

Start everything:
```bash
# From parent directory
npm start
```

This starts the webapp (`:3001`), this MCP server (`:8080`), and the sibling
[`users-mcp-server`](../users-mcp-server/README.md) (`:8081`) concurrently.

## Auth model vs. `users-mcp-server`

This server is authorized with a reusable **ID-JAG access token** (1hr TTL) - the
webapp does the ID-JAG token dance once and reuses the resulting access token as a
normal Bearer credential for every tool call.

`users-mcp-server` uses a completely different model: the agent holds **no API key at
all** and instead requests a fresh, short-lived secret from **Okta Privileged Access
Manager (PAM)** on every single call. See [`users-mcp-server/README.md`](../users-mcp-server/README.md)
for that flow.

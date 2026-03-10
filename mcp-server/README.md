# NIST CSF 2.0 MCP Server

Model Context Protocol server providing 38 tools for NIST Cybersecurity Framework 2.0.

## Setup

```bash
cd mcp-server

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

Start both:
```bash
# From parent directory
npm run start:all
```

This starts both the MCP server (8080) and webapp (3001).

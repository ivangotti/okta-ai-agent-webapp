#!/bin/bash

# NIST CSF 2.0 - Stop All Services

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${YELLOW}[STOPPING]${NC} NIST CSF 2.0 Services..."

# Kill by PID files
if [ -f /tmp/nist-csf-mcp.pid ]; then
    MCP_PID=$(cat /tmp/nist-csf-mcp.pid)
    kill $MCP_PID 2>/dev/null && echo -e "${GREEN}[STOPPED]${NC} MCP Server (PID: $MCP_PID)"
    rm -f /tmp/nist-csf-mcp.pid
fi

if [ -f /tmp/nist-csf-webapp.pid ]; then
    WEBAPP_PID=$(cat /tmp/nist-csf-webapp.pid)
    kill $WEBAPP_PID 2>/dev/null && echo -e "${GREEN}[STOPPED]${NC} Webapp (PID: $WEBAPP_PID)"
    rm -f /tmp/nist-csf-webapp.pid
fi

# Also kill by port (backup)
lsof -ti:8080 | xargs kill -9 2>/dev/null && echo -e "${GREEN}[STOPPED]${NC} Process on port 8080" || true
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo -e "${GREEN}[STOPPED]${NC} Process on port 3001" || true

# Clean up log files
rm -f /tmp/nist-mcp-server.log /tmp/webapp.log

echo -e "${GREEN}[DONE]${NC} All services stopped"
echo ""

#!/bin/bash

# NIST CSF 2.0 - Start All Services
# Starts both MCP HTTP Server and Chatbot Webapp

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}       ${BOLD}NIST CSF 2.0 - Starting All Services${NC}                        ${CYAN}║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if webapp dependencies are installed
if [ ! -d "$PROJECT_ROOT/webapp/node_modules" ]; then
    echo -e "${YELLOW}[SETUP]${NC} Installing webapp dependencies..."
    cd "$PROJECT_ROOT/webapp" && npm install
fi

# Kill any existing processes on our ports
echo -e "${YELLOW}[CLEANUP]${NC} Checking for existing processes..."
lsof -ti:8080 | xargs kill -9 2>/dev/null || true
lsof -ti:3001 | xargs kill -9 2>/dev/null || true
sleep 1

# Start MCP HTTP Server
echo -e "${BLUE}[STARTING]${NC} MCP HTTP Server on port 8080..."
cd "$PROJECT_ROOT"
node dist/http-server.js > /tmp/mcp-server.log 2>&1 &
MCP_PID=$!
echo -e "${GREEN}[STARTED]${NC} MCP Server PID: $MCP_PID"

# Wait for MCP server to be ready
echo -e "${YELLOW}[WAITING]${NC} Waiting for MCP server to initialize..."
for i in {1..10}; do
    if curl -s http://localhost:8080/health > /dev/null 2>&1; then
        echo -e "${GREEN}[READY]${NC} MCP Server is healthy"
        break
    fi
    sleep 1
done

# Start Webapp
echo -e "${BLUE}[STARTING]${NC} Chatbot Webapp on port 3001..."
cd "$PROJECT_ROOT/webapp"
node server.js > /tmp/webapp.log 2>&1 &
WEBAPP_PID=$!
echo -e "${GREEN}[STARTED]${NC} Webapp PID: $WEBAPP_PID"

# Wait for webapp to be ready
echo -e "${YELLOW}[WAITING]${NC} Waiting for webapp to initialize..."
for i in {1..10}; do
    if curl -s http://localhost:3001/api/health > /dev/null 2>&1; then
        echo -e "${GREEN}[READY]${NC} Webapp is healthy"
        break
    fi
    sleep 1
done

# Get health status
MCP_HEALTH=$(curl -s http://localhost:8080/health 2>/dev/null | grep -o '"tools_available":[0-9]*' | cut -d: -f2 || echo "?")
WEBAPP_HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "?")

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}                    ${BOLD}ALL SERVICES RUNNING${NC}                           ${GREEN}║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}                                                                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${BOLD}MCP HTTP Server${NC}                                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ URL:      ${CYAN}http://localhost:8080${NC}                              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ Health:   ${CYAN}http://localhost:8080/health${NC}                       ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ Tools:    ${CYAN}http://localhost:8080/api/tools${NC}                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ Status:   ${GREEN}Running${NC} (${MCP_HEALTH} tools available)                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  └─ PID:      ${YELLOW}${MCP_PID}${NC}                                                 ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${BOLD}Chatbot Webapp${NC} (Okta Protected)                                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ URL:      ${CYAN}http://localhost:3001${NC}                              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ Login:    ${CYAN}http://localhost:3001/login${NC}                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ Logout:   ${CYAN}http://localhost:3001/logout${NC}                       ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ Health:   ${CYAN}http://localhost:3001/api/health${NC}                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ├─ Status:   ${GREEN}Running${NC} (${WEBAPP_HEALTH})                                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  └─ PID:      ${YELLOW}${WEBAPP_PID}${NC}                                                 ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                                    ${GREEN}║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  ${BOLD}Quick Access:${NC}                                                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  → Open ${CYAN}http://localhost:3001${NC} in your browser                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  → Login with your Okta credentials                                ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  → Start chatting about NIST CSF 2.0!                              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                                    ${GREEN}║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  ${BOLD}Logs:${NC}                                                             ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  → MCP Server:  ${YELLOW}tail -f /tmp/mcp-server.log${NC}                       ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  → Webapp:      ${YELLOW}tail -f /tmp/webapp.log${NC}                           ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                                    ${GREEN}║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  ${BOLD}Stop Services:${NC}                                                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  → Press ${RED}Ctrl+C${NC} or run: ${YELLOW}npm run stop:all${NC}                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                                    ${GREEN}║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Save PIDs for stop script
echo "$MCP_PID" > /tmp/nist-csf-mcp.pid
echo "$WEBAPP_PID" > /tmp/nist-csf-webapp.pid

# Trap Ctrl+C to cleanup
cleanup() {
    echo ""
    echo -e "${YELLOW}[STOPPING]${NC} Shutting down services..."
    kill $MCP_PID 2>/dev/null || true
    kill $WEBAPP_PID 2>/dev/null || true
    rm -f /tmp/nist-csf-mcp.pid /tmp/nist-csf-webapp.pid
    echo -e "${GREEN}[STOPPED]${NC} All services stopped"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Keep script running and follow logs
echo -e "${CYAN}[LOGS]${NC} Streaming logs (Ctrl+C to stop all services)..."
echo ""
tail -f /tmp/mcp-server.log /tmp/webapp.log 2>/dev/null

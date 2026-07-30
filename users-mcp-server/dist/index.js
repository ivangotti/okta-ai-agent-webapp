#!/usr/bin/env node
/**
 * Users MCP Server - stdio entrypoint (for generic MCP clients such as
 * Claude Desktop).
 *
 * NOTE: The primary integration path today is the HTTP REST wrapper
 * (src/http-server.ts), used by the webapp - it has access to the logged
 * -in user's raw ID token from their session. Stdio MCP clients have no
 * per-request Bearer token, so this mode accepts the user's ID token as an
 * explicit tool argument instead.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ErrorCode, McpError, } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { searchUsers, SearchUsersSchema } from './tools/search_users.js';
import { getSalesforceServiceAccount, GetSalesforceServiceAccountSchema } from './tools/get_salesforce_service_account.js';
const StdioSearchUsersSchema = SearchUsersSchema.and(z.object({
    user_id_token: z.string().describe("The caller's raw Okta ID token, used as the subject_token for the vaulted-secret exchange"),
}));
const StdioGetSalesforceServiceAccountSchema = GetSalesforceServiceAccountSchema.and(z.object({
    user_id_token: z.string().describe("The caller's raw Okta ID token, used as the subject_token for the service-account exchange"),
}));
async function main() {
    logger.info('Starting Users MCP Server...');
    const server = new Server({ name: 'okta-users-mcp-server', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'search-users',
                description: 'Search Okta users by firstName, lastName, and/or email',
                inputSchema: {
                    type: 'object',
                    properties: {
                        firstName: { type: 'string', description: 'First name to search for' },
                        lastName: { type: 'string', description: 'Last name to search for' },
                        email: { type: 'string', description: 'Email address to search for' },
                        limit: { type: 'number', description: 'Maximum results (1-200)', default: 20 },
                        user_id_token: { type: 'string', description: "Caller's raw Okta ID token (stdio mode only)" },
                    },
                    required: ['user_id_token'],
                },
            },
            {
                name: 'get-salesforce-service-account',
                description: 'Retrieve the Salesforce service-account credential vaulted in Okta PAM (O4AA service-account token exchange)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        user_id_token: { type: 'string', description: "Caller's raw Okta ID token (stdio mode only)" },
                    },
                    required: ['user_id_token'],
                },
            },
        ],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case 'search-users': {
                    const { user_id_token, ...params } = StdioSearchUsersSchema.parse(args);
                    const result = await searchUsers(params, user_id_token);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                    };
                }
                case 'get-salesforce-service-account': {
                    const { user_id_token, ...params } = StdioGetSalesforceServiceAccountSchema.parse(args);
                    const result = await getSalesforceServiceAccount(params, user_id_token);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                    };
                }
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            }
        }
        catch (error) {
            if (error instanceof z.ZodError) {
                throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
            }
            if (error instanceof McpError)
                throw error;
            logger.error(`Tool execution error: ${name}`, error);
            throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error}`);
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Users MCP Server running on stdio transport');
    await new Promise(() => { });
}
main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
});

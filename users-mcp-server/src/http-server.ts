#!/usr/bin/env node
/**
 * HTTP REST API server for the Okta Users MCP Server.
 *
 * Unlike nist-mcp-server (which expects an ID-JAG-derived access token
 * scoped to that MCP server's audience), this server expects the caller's
 * RAW Okta ID token as the Bearer credential. That raw ID token is the
 * subject_token needed for the O4AA vaulted-secret exchange performed on
 * every search-users call - see src/services/okta-token-exchange.ts.
 */

import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { logger } from './utils/logger.js';
import { searchUsers, SearchUsersSchema } from './tools/search_users.js';

interface HttpApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: string;
  tool: string;
}

declare global {
  namespace Express {
    interface Request {
      userIdToken?: string;
    }
  }
}

/**
 * Light sanity check on the incoming ID token: decode it, confirm it's not
 * expired, and confirm the issuer matches this org. We deliberately do NOT
 * re-verify the signature here (mirrors nist-mcp-server's existing
 * shortcut) - Okta itself is the final authority when this token is used
 * as subject_token in the vaulted-secret exchange; an invalid/expired/
 * forged token will simply be rejected there.
 */
function extractUserIdToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json(createErrorResponse('auth', 'Missing or invalid Authorization header'));
  }

  const token = authHeader.substring(7);
  const decoded = jwt.decode(token) as { exp?: number; iss?: string } | null;
  const oktaIssuer = process.env.OKTA_ISSUER || 'https://blackcastle.oktapreview.com';

  if (!decoded) {
    return res.status(401).json(createErrorResponse('auth', 'Malformed ID token'));
  }
  if (decoded.exp && decoded.exp * 1000 < Date.now()) {
    return res.status(401).json(createErrorResponse('auth', 'ID token expired'));
  }
  if (decoded.iss && oktaIssuer && decoded.iss !== oktaIssuer) {
    return res.status(401).json(createErrorResponse('auth', `Unexpected ID token issuer: ${decoded.iss}`));
  }

  req.userIdToken = token;
  next();
}

function createSuccessResponse(toolName: string, data: unknown): HttpApiResponse {
  return { success: true, data, timestamp: new Date().toISOString(), tool: toolName };
}

function createErrorResponse(toolName: string, error: string): HttpApiResponse {
  return { success: false, error, timestamp: new Date().toISOString(), tool: toolName };
}

export async function startHttpServer(port: number = 8081): Promise<void> {
  const app = express();

  app.use(helmet());
  app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.RATE_LIMIT ? parseInt(process.env.RATE_LIMIT) : 100,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      mode: 'http-rest-api',
      tools_available: 1,
    });
  });

  app.get('/api/tools', (_req, res) => {
    res.json({
      success: true,
      message: 'Okta Users MCP Server - HTTP REST API',
      tools: [
        {
          name: 'search-users',
          endpoint: '/api/tools/search-users',
          method: 'POST',
          description: 'Search Okta users by firstName, lastName, and/or email',
        },
      ],
    });
  });

  app.post('/api/tools/search-users', extractUserIdToken, async (req, res) => {
    try {
      const params = SearchUsersSchema.parse(req.body);
      logger.info('Executing search-users', { params: { ...params, email: params.email ? '[redacted]' : undefined } });

      const result = await searchUsers(params, req.userIdToken!);

      if (!result.success) {
        return res.status(502).json(createErrorResponse('search-users', result.error || 'Unknown error'));
      }

      return res.json(createSuccessResponse('search-users', result));
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return res.status(400).json(createErrorResponse('search-users', `Invalid parameters: ${error.message}`));
      }
      logger.error('search-users request failed', { error: error.message });
      return res.status(500).json(createErrorResponse('search-users', error.message));
    }
  });

  app.use((req, res) => {
    res.status(404).json(createErrorResponse('not_found', `Endpoint not found: ${req.path}`));
  });

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`🌐 Okta Users MCP Server (HTTP) running on port ${port}`);
    logger.info(`📖 API Documentation: http://localhost:${port}/api/tools`);
    logger.info(`💚 Health Check: http://localhost:${port}/health`);
    logger.info(`🔧 Available Tools: 1`);
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT) : 8081;
  startHttpServer(port).catch((error) => {
    logger.error('Failed to start HTTP server:', error);
    process.exit(1);
  });
}

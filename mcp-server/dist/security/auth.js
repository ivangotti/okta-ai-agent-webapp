/**
 * Authentication middleware for MCP server
 * Supports three modes:
 * 1. DISABLED (default) - No authentication required
 * 2. SIMPLE - API key authentication via Bearer token
 * 3. OAUTH - Full OAuth 2.1 Client Credentials with JWT validation
 */
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
export class AuthMiddleware {
    client;
    config;
    constructor(config) {
        // Determine authentication mode from environment
        const mode = this.determineAuthMode();
        this.config = {
            mode,
            // Simple auth config
            apiKey: config?.apiKey || process.env.API_KEY,
            // OAuth config
            jwksUrl: config?.jwksUrl || process.env.JWKS_URL,
            audience: config?.audience || process.env.MCP_AUDIENCE,
            issuer: config?.issuer || process.env.TOKEN_ISSUER,
            algorithms: config?.algorithms || ['RS256']
        };
        // Only initialize JWKS client for OAuth mode
        if (this.config.mode === 'oauth') {
            if (!this.config.jwksUrl) {
                throw new Error('JWKS_URL is required for OAuth authentication mode');
            }
            this.client = jwksClient({
                jwksUri: this.config.jwksUrl,
                cache: true,
                cacheMaxAge: 600000, // 10 minutes
                rateLimit: true,
                jwksRequestsPerMinute: 10
            });
        }
        // Write to stderr for MCP compatibility
        process.stderr.write(`🔒 Authentication mode: ${this.config.mode.toUpperCase()}\n`);
    }
    /**
     * Determine authentication mode from environment variables
     */
    determineAuthMode() {
        // Check for explicit simple auth flag
        if (process.env.SIMPLE_AUTH === 'true' || process.env.AUTH_MODE === 'simple') {
            return 'simple';
        }
        // Check for OAuth configuration
        if (process.env.JWKS_URL || process.env.AUTH_MODE === 'oauth') {
            return 'oauth';
        }
        // Default to disabled for easy initial setup
        return 'disabled';
    }
    /**
     * Extract Bearer token from Authorization header
     */
    extractToken(req) {
        const authHeader = req.headers.authorization;
        if (!authHeader)
            return null;
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return null;
        }
        return parts[1] || null;
    }
    /**
     * Get signing key from JWKS (OAuth mode only)
     */
    getKey(header, callback) {
        if (!this.client) {
            callback(new Error('JWKS client not initialized'));
            return;
        }
        this.client.getSigningKey(header.kid, (err, key) => {
            if (err) {
                callback(err);
            }
            else {
                const signingKey = key?.getPublicKey();
                callback(null, signingKey);
            }
        });
    }
    /**
     * Validate simple API key
     */
    validateApiKey(token) {
        if (!this.config.apiKey) {
            process.stderr.write('⚠️  Simple auth enabled but no API_KEY configured\n');
            return null;
        }
        if (token === this.config.apiKey) {
            return {
                authenticated: true,
                mode: 'simple',
                scope: 'all' // Simple mode grants all permissions
            };
        }
        return null;
    }
    /**
     * Validate JWT token (OAuth mode only)
     */
    async validateJwtToken(token) {
        return new Promise((resolve, reject) => {
            jwt.verify(token, this.getKey.bind(this), {
                audience: this.config.audience,
                issuer: this.config.issuer,
                algorithms: this.config.algorithms,
                maxAge: '15m' // Token lifetime < 15 minutes as per requirements
            }, (err, decoded) => {
                if (err) {
                    reject(err);
                    return;
                }
                else {
                    resolve(decoded);
                    return;
                }
            });
        });
    }
    /**
     * Middleware to validate authentication
     */
    authenticate() {
        return async (req, res, next) => {
            // Disabled mode - no authentication required
            if (this.config.mode === 'disabled') {
                req.auth = { authenticated: false, mode: 'disabled' };
                next();
                return;
            }
            // Extract token for simple and OAuth modes
            const token = this.extractToken(req);
            if (!token) {
                return res.status(401).json({
                    error: 'Unauthorized - No token provided'
                });
            }
            try {
                // Simple authentication mode
                if (this.config.mode === 'simple') {
                    const validated = this.validateApiKey(token);
                    if (!validated) {
                        return res.status(401).json({
                            error: 'Unauthorized - Invalid credentials'
                        });
                    }
                    req.auth = validated;
                    next();
                    return;
                }
                // OAuth authentication mode
                if (this.config.mode === 'oauth') {
                    const decoded = await this.validateJwtToken(token);
                    req.auth = decoded;
                    next();
                    return;
                }
                // This should never happen
                return res.status(500).json({ error: 'Invalid authentication configuration' });
            }
            catch (error) {
                if (error instanceof jwt.TokenExpiredError) {
                    return res.status(401).json({ error: 'Unauthorized - Token expired' });
                }
                else if (error instanceof jwt.JsonWebTokenError) {
                    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
                }
                // Don't expose internal error details
                process.stderr.write(`Authentication error: ${error}\n`);
                return res.status(401).json({ error: 'Unauthorized' });
            }
        };
    }
    /**
     * Middleware to check required scopes
     */
    requireScope(requiredScope) {
        return async (req, res, next) => {
            const auth = req.auth;
            // Disabled mode - allow all operations
            if (this.config.mode === 'disabled' || auth?.mode === 'disabled') {
                next();
                return;
            }
            if (!auth) {
                return res.status(401).json({ error: 'Unauthorized - Not authenticated' });
            }
            // Simple mode - all permissions granted
            if (auth.mode === 'simple' || auth.scope === 'all') {
                next();
                return;
            }
            // OAuth mode - check specific scopes
            const scopes = auth.scope?.split(' ') || [];
            if (!scopes.includes(requiredScope)) {
                return res.status(403).json({
                    error: 'Forbidden - Insufficient permissions'
                });
            }
            next();
            return;
        };
    }
    /**
     * Middleware to check tool-specific permissions
     */
    requireToolPermission(toolName) {
        return this.requireScope(`tool:${toolName}`);
    }
    /**
     * Get current authentication mode
     */
    getAuthMode() {
        return this.config.mode;
    }
    /**
     * Check if authentication is currently enabled
     */
    isAuthEnabled() {
        return this.config.mode !== 'disabled';
    }
}
// Export singleton instance
export const authMiddleware = new AuthMiddleware();

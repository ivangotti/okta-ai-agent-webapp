/**
 * Monitoring middleware for request/response tracking
 */
import { logger } from '../utils/enhanced-logger.js';
import { metrics } from '../utils/metrics.js';
import { toolAnalytics } from '../utils/analytics.js';
/**
 * Correlation ID middleware
 */
export function correlationIdMiddleware(req, res, next) {
    const correlationId = req.headers['x-correlation-id'] ||
        req.headers['x-request-id'] ||
        logger.generateCorrelationId();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    // Run the rest of the request in correlation context
    logger.withCorrelationId(correlationId, () => {
        next();
    });
}
/**
 * Request logging middleware
 */
export function requestLoggingMiddleware(req, res, next) {
    req.startTime = process.hrtime.bigint();
    // Log request
    logger.info('Incoming request', {
        correlationId: req.correlationId,
        method: req.method,
        path: req.path,
        query: JSON.stringify(req.query),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        contentType: req.headers['content-type'],
        userId: req.auth?.sub,
    });
    // Capture response
    const originalSend = res.send;
    const originalJson = res.json;
    res.send = function (data) {
        res.locals.responseBody = data;
        return originalSend.call(this, data);
    };
    res.json = function (data) {
        res.locals.responseBody = data;
        return originalJson.call(this, data);
    };
    next();
}
/**
 * Response logging middleware
 */
export function responseLoggingMiddleware(req, res, next) {
    // Log response on finish
    res.on('finish', () => {
        if (req.startTime) {
            const duration = Number(process.hrtime.bigint() - req.startTime) / 1000000; // ms
            // Log response
            const logLevel = res.statusCode >= 400 ? 'error' : 'info';
            logger[logLevel]('Request completed', {
                correlationId: req.correlationId,
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
                duration,
                userId: req.auth?.sub,
                errorMessage: res.statusCode >= 400 ? res.locals.responseBody?.error : undefined,
            });
            // Record metrics
            metrics.record('http_request_duration', duration, {
                method: req.method,
                path: req.path.replace(/\/[a-f0-9-]+/g, '/:id'), // Normalize paths
                status: res.statusCode.toString(),
            });
            metrics.increment('http_requests_total', {
                method: req.method,
                path: req.path.replace(/\/[a-f0-9-]+/g, '/:id'),
                status: res.statusCode.toString(),
            });
            if (res.statusCode >= 400) {
                metrics.increment('errors_total', {
                    type: 'http',
                    code: res.statusCode.toString(),
                });
            }
        }
    });
    next();
}
/**
 * Tool execution monitoring
 */
export function toolMonitoring(toolName, execute) {
    return async function (...args) {
        const correlationId = logger.getCorrelationId();
        const timer = metrics.startTimer('tool_execution_duration');
        // Extract client info from context if available
        const clientId = this?.clientId || 'unknown';
        const userId = this?.userId;
        logger.info('Tool execution started', {
            correlationId,
            toolName,
            clientId,
            userId,
            params: args[0], // Assuming first arg is params
        });
        try {
            const result = await execute.apply(this, args);
            const duration = timer();
            logger.info('Tool execution completed', {
                correlationId,
                toolName,
                clientId,
                userId,
                duration,
                success: true,
            });
            // Record analytics
            toolAnalytics.recordToolExecution(toolName, duration, true, clientId, userId, undefined, args[0]);
            metrics.timing('tool_execution_duration', duration, {
                tool: toolName,
                status: 'success',
            });
            metrics.increment('tool_executions_total', {
                tool: toolName,
                status: 'success',
            });
            return result;
        }
        catch (error) {
            const duration = timer();
            const errorMessage = error.message;
            logger.error('Tool execution failed', error, {
                correlationId,
                toolName,
                clientId,
                userId,
                duration,
            });
            // Record analytics for failed execution
            toolAnalytics.recordToolExecution(toolName, duration, false, clientId, userId, errorMessage, args[0]);
            metrics.timing('tool_execution_duration', duration, {
                tool: toolName,
                status: 'error',
            });
            metrics.increment('tool_executions_total', {
                tool: toolName,
                status: 'error',
            });
            metrics.increment('errors_total', {
                type: 'tool',
                code: error.code || 'UNKNOWN',
            });
            throw error;
        }
    };
}
/**
 * Database query monitoring
 */
export function monitorDatabaseQuery(operation, table, execute) {
    return async function (...args) {
        const correlationId = logger.getCorrelationId();
        const timer = metrics.startTimer('db_query_duration');
        logger.debug('Database query started', {
            correlationId,
            operation,
            table,
            query: args[0]?.substring?.(0, 200), // Truncate long queries
        });
        try {
            const result = await execute.apply(this, args);
            const duration = timer();
            logger.debug('Database query completed', {
                correlationId,
                operation,
                table,
                duration,
                rowCount: Array.isArray(result) ? result.length : undefined,
            });
            metrics.timing('db_query_duration', duration, {
                operation,
                table,
            });
            metrics.increment('db_queries_total', {
                operation,
                table,
                status: 'success',
            });
            return result;
        }
        catch (error) {
            const duration = timer();
            logger.error('Database query failed', error, {
                correlationId,
                operation,
                table,
                duration,
            });
            metrics.timing('db_query_duration', duration, {
                operation,
                table,
            });
            metrics.increment('db_queries_total', {
                operation,
                table,
                status: 'error',
            });
            metrics.increment('errors_total', {
                type: 'database',
                code: error.code || 'UNKNOWN',
            });
            throw error;
        }
    };
}
/**
 * Error handling middleware
 */
export function errorMonitoringMiddleware(err, req, res, _next) {
    const correlationId = req.correlationId || logger.generateCorrelationId();
    logger.error('Unhandled error in request', err, {
        correlationId,
        method: req.method,
        path: req.path,
        userId: req.auth?.sub,
    });
    metrics.increment('errors_total', {
        type: 'unhandled',
        code: err.code || 'UNKNOWN',
    });
    // Send error response
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' ?
            'Internal server error' : err.message,
        correlationId,
    });
}
/**
 * Health check endpoint with metrics
 */
export function healthCheckHandler(req, res) {
    const healthData = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        metrics: metrics.exportJSON(),
        memory: process.memoryUsage(),
        correlationId: req.correlationId,
    };
    logger.debug('Health check requested', {
        correlationId: req.correlationId,
    });
    res.json(healthData);
}
/**
 * Metrics endpoint for Prometheus
 */
export function metricsHandler(req, res) {
    const prometheusMetrics = metrics.exportPrometheus();
    logger.debug('Metrics requested', {
        correlationId: req.correlationId,
    });
    res.set('Content-Type', 'text/plain');
    res.send(prometheusMetrics);
}
/**
 * Create monitoring router
 */
export function createMonitoringRouter(express) {
    const router = express.Router();
    // Health check with enhanced data
    router.get('/health', (req, res) => {
        const healthData = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            metrics: metrics.exportJSON(),
            analytics: toolAnalytics.generateSummary(),
            memory: process.memoryUsage(),
            correlationId: req.correlationId,
        };
        logger.debug('Health check requested', {
            correlationId: req.correlationId,
        });
        res.json(healthData);
    });
    // Metrics endpoint for Prometheus
    router.get('/metrics', metricsHandler);
    // Analytics endpoints
    router.get('/analytics', (req, res) => {
        logger.debug('Analytics requested', {
            correlationId: req.correlationId,
        });
        res.json({
            success: true,
            data: toolAnalytics.generateSummary(),
            correlationId: req.correlationId,
        });
    });
    router.get('/analytics/tools', (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        logger.debug('Tool analytics requested', {
            correlationId: req.correlationId,
            limit,
        });
        res.json({
            success: true,
            data: {
                tools: toolAnalytics.getToolStats().slice(0, limit),
                topTools: toolAnalytics.getTopTools(10),
                slowestTools: toolAnalytics.getSlowestTools(10),
                errorProneTools: toolAnalytics.getErrorProneTools(10),
            },
            correlationId: req.correlationId,
        });
    });
    router.get('/analytics/users', (req, res) => {
        const hours = parseInt(req.query.hours) || 24;
        logger.debug('User analytics requested', {
            correlationId: req.correlationId,
            hours,
        });
        res.json({
            success: true,
            data: {
                activeUsers: toolAnalytics.getActiveUsers(hours),
                allUsers: toolAnalytics.getUserStats().slice(0, 100), // Limit for performance
            },
            correlationId: req.correlationId,
        });
    });
    router.get('/analytics/performance', (req, res) => {
        const hoursBack = parseInt(req.query.hours) || 24;
        const startTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
        logger.debug('Performance analytics requested', {
            correlationId: req.correlationId,
            hoursBack,
        });
        const performanceData = toolAnalytics.getPerformanceMetrics(startTime);
        res.json({
            success: true,
            data: {
                timeRange: { start: startTime.toISOString(), end: new Date().toISOString() },
                totalRecords: performanceData.length,
                records: performanceData.slice(0, 1000), // Limit for performance
            },
            correlationId: req.correlationId,
        });
    });
    // Analytics export endpoint
    router.get('/analytics/export', (req, res) => {
        logger.info('Analytics export requested', {
            correlationId: req.correlationId,
        });
        const exportData = toolAnalytics.exportData();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="analytics-export-${Date.now()}.json"`);
        res.json(exportData);
    });
    // Analytics reset endpoint (admin only)
    if (process.env.NODE_ENV === 'development') {
        router.post('/analytics/reset', (req, res) => {
            logger.warn('Analytics reset requested', {
                correlationId: req.correlationId,
            });
            toolAnalytics.reset();
            res.json({
                success: true,
                message: 'Analytics data reset',
                correlationId: req.correlationId,
            });
        });
    }
    // Logs endpoint (for development)
    if (process.env.NODE_ENV === 'development') {
        router.get('/logs', (req, res) => {
            // This would typically read from log files
            res.json({
                message: 'Logs endpoint - implement file reading logic',
                correlationId: req.correlationId,
            });
        });
    }
    return router;
}
// Export middleware array for easy application
export const monitoringMiddleware = [
    correlationIdMiddleware,
    requestLoggingMiddleware,
    responseLoggingMiddleware,
];

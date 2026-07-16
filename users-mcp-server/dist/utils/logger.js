/**
 * Logger configuration for the Okta Users MCP Server
 */
import winston from 'winston';
import path from 'path';
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
};
winston.addColors(colors);
const consoleFormat = winston.format.combine(winston.format.colorize(), winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
        msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
}));
const fileFormat = winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston.format.json());
// MCP stdio servers must reserve stdout for the JSON-RPC protocol
const isMcpServer = process.argv.includes('--mcp') ||
    process.env.MCP_SERVER === 'true' ||
    process.stdin.isTTY === false;
export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    levels,
    transports: [
        ...(isMcpServer ? [] : [
            new winston.transports.Console({
                format: consoleFormat,
            })
        ]),
        ...(isMcpServer ? [
            new winston.transports.Console({
                stderrLevels: ['error', 'warn', 'info', 'debug'],
                format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    let msg = `${timestamp} [MCP] [${level}]: ${message}`;
                    if (Object.keys(meta).length > 0) {
                        msg += ` ${JSON.stringify(meta)}`;
                    }
                    return msg;
                })),
            })
        ] : []),
        new winston.transports.File({
            filename: path.join(process.cwd(), 'logs/error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 5242880,
            maxFiles: 5,
        }),
        new winston.transports.File({
            filename: path.join(process.cwd(), 'logs/combined.log'),
            format: fileFormat,
            maxsize: 10485760,
            maxFiles: 10,
        }),
    ],
    exitOnError: false,
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', { promise, reason });
});
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});
export default logger;

/**
 * Database wrapper with monitoring capabilities
 */
import { CSFDatabase } from './database.js';
import { monitorDatabaseQuery } from '../middleware/monitoring.js';
import { logger } from '../utils/enhanced-logger.js';
import { metrics } from '../utils/metrics.js';
export class MonitoredDatabase extends CSFDatabase {
    constructor(dbPath) {
        super(dbPath);
        this.wrapMethods();
    }
    /**
     * Wrap database methods with monitoring
     */
    wrapMethods() {
        // Wrap main query methods that exist in CSFDatabase
        const originalGetOrganization = this.getOrganization.bind(this);
        this.getOrganization = monitorDatabaseQuery('SELECT', 'organizations', originalGetOrganization);
        const originalCreateOrganization = this.createOrganization.bind(this);
        this.createOrganization = monitorDatabaseQuery('INSERT', 'organizations', originalCreateOrganization);
        const originalUpsertImplementation = this.upsertImplementation.bind(this);
        this.upsertImplementation = monitorDatabaseQuery('UPSERT', 'implementations', originalUpsertImplementation);
        const originalGetImplementations = this.getImplementations.bind(this);
        this.getImplementations = monitorDatabaseQuery('SELECT', 'implementations', originalGetImplementations);
        const originalUpsertRiskAssessment = this.upsertRiskAssessment.bind(this);
        this.upsertRiskAssessment = monitorDatabaseQuery('UPSERT', 'risk_assessments', originalUpsertRiskAssessment);
        const originalGetRiskAssessments = this.getRiskAssessments.bind(this);
        this.getRiskAssessments = monitorDatabaseQuery('SELECT', 'risk_assessments', originalGetRiskAssessments);
        const originalUpsertGapAnalysis = this.upsertGapAnalysis.bind(this);
        this.upsertGapAnalysis = monitorDatabaseQuery('UPSERT', 'gap_analyses', originalUpsertGapAnalysis);
        const originalGetGapAnalyses = this.getGapAnalyses.bind(this);
        this.getGapAnalyses = monitorDatabaseQuery('SELECT', 'gap_analyses', originalGetGapAnalyses);
    }
    /**
     * Get database statistics with monitoring
     */
    getStats() {
        const timer = metrics.startTimer('db_query_duration');
        try {
            const stats = super.getStats();
            const duration = timer();
            logger.debug('Database stats retrieved', {
                duration,
                stats,
            });
            metrics.timing('db_query_duration', duration, {
                operation: 'STATS',
                table: 'multiple',
            });
            const typedStats = stats;
            metrics.gauge('db_organizations_count', typedStats.organizations || 0);
            metrics.gauge('db_implementations_count', typedStats.implementations || 0);
            metrics.gauge('db_risk_assessments_count', typedStats.risk_assessments || 0);
            metrics.gauge('db_gap_analyses_count', typedStats.gaps || 0);
            return stats;
        }
        catch (error) {
            const duration = timer();
            logger.error('Failed to get database stats', error, {
                duration,
            });
            throw error;
        }
    }
    /**
     * Create a new profile with monitoring
     */
    createProfile(profile) {
        const timer = metrics.startTimer('db_query_duration');
        const correlationId = logger.getCorrelationId();
        logger.info('Creating profile', {
            correlationId,
            organizationId: profile.org_id,
            profileType: profile.profile_type,
        });
        try {
            super.createProfile(profile);
            const duration = timer();
            logger.info('Profile created successfully', {
                correlationId,
                profileId: profile.profile_id,
                duration,
            });
            metrics.timing('db_query_duration', duration, {
                operation: 'INSERT',
                table: 'profiles',
            });
            metrics.increment('db_queries_total', {
                operation: 'INSERT',
                table: 'profiles',
                status: 'success',
            });
        }
        catch (error) {
            const duration = timer();
            logger.error('Failed to create profile', error, {
                correlationId,
                duration,
            });
            metrics.timing('db_query_duration', duration, {
                operation: 'INSERT',
                table: 'profiles',
            });
            metrics.increment('db_queries_total', {
                operation: 'INSERT',
                table: 'profiles',
                status: 'error',
            });
            throw error;
        }
    }
    /**
     * Get assessment with monitoring
     */
    getAssessment(profileId, subcategoryId) {
        const timer = metrics.startTimer('db_query_duration');
        const correlationId = logger.getCorrelationId();
        logger.debug('Getting assessment', {
            correlationId,
            profileId,
            subcategoryId,
        });
        try {
            const assessment = super.getAssessment(profileId);
            const duration = timer();
            logger.debug('Assessment retrieved', {
                correlationId,
                profileId,
                resultCount: Array.isArray(assessment) ? assessment.length : 1,
                duration,
            });
            metrics.timing('db_query_duration', duration, {
                operation: 'SELECT',
                table: 'assessments',
            });
            return assessment;
        }
        catch (error) {
            const duration = timer();
            logger.error('Failed to get assessment', error, {
                correlationId,
                profileId,
                duration,
            });
            metrics.timing('db_query_duration', duration, {
                operation: 'SELECT',
                table: 'assessments',
            });
            throw error;
        }
    }
    /**
     * Import assessment batch with monitoring
     */
    importAssessmentBatch(profileId, assessments) {
        const timer = metrics.startTimer('db_query_duration');
        const correlationId = logger.getCorrelationId();
        logger.info('Importing assessment batch', {
            correlationId,
            profileId,
            batchSize: assessments.length,
        });
        try {
            const result = super.importAssessmentBatch(profileId, assessments);
            const duration = timer();
            logger.info('Assessment batch imported', {
                correlationId,
                profileId,
                imported: result.imported,
                skipped: result.skipped,
                updated: result.updated || 0,
                duration,
            });
            metrics.timing('db_query_duration', duration, {
                operation: 'BATCH_INSERT',
                table: 'assessments',
            });
            metrics.increment('db_batch_operations_total', {
                operation: 'import',
                table: 'assessments',
                status: 'success',
            });
            return result;
        }
        catch (error) {
            const duration = timer();
            logger.error('Failed to import assessment batch', error, {
                correlationId,
                profileId,
                batchSize: assessments.length,
                duration,
            });
            metrics.timing('db_query_duration', duration, {
                operation: 'BATCH_INSERT',
                table: 'assessments',
            });
            metrics.increment('db_batch_operations_total', {
                operation: 'import',
                table: 'assessments',
                status: 'error',
            });
            throw error;
        }
    }
}
/**
 * Create a monitored database instance
 */
let monitoredDb = null;
export function getMonitoredDatabase() {
    if (!monitoredDb) {
        monitoredDb = new MonitoredDatabase();
        logger.info('Monitored database initialized', {
            dbPath: process.env.DATABASE_PATH || './data/nist-csf-2.0.db',
        });
    }
    return monitoredDb;
}
export function closeMonitoredDatabase() {
    if (monitoredDb) {
        monitoredDb.close();
        monitoredDb = null;
        logger.info('Monitored database closed');
    }
}

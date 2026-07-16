import { z } from 'zod';
import { getDatabase } from '../db/database.js';
import { logger } from '../utils/enhanced-logger.js';
const ResetOrganizationalDataSchema = z.object({
    confirmation: z.literal('CONFIRM_RESET_ALL_ORGANIZATIONAL_DATA').describe('Must be exactly "CONFIRM_RESET_ALL_ORGANIZATIONAL_DATA" to proceed')
});
/**
 * Reset organizational data - removes all organization profiles, assessments, and related data
 * while preserving NIST CSF framework data, questions, and baseline information
 */
export async function resetOrganizationalData(params) {
    try {
        // Validate confirmation parameter
        ResetOrganizationalDataSchema.parse(params);
        const db = getDatabase();
        logger.info('Starting organizational data reset operation', {
            operation: 'reset_organizational_data',
            timestamp: new Date().toISOString()
        });
        // Count existing data before deletion for reporting
        const beforeCounts = {
            organizations: db.prepare('SELECT COUNT(*) as count FROM organization_profiles').get(),
            profiles: db.prepare('SELECT COUNT(*) as count FROM profiles').get(),
            assessments: db.prepare('SELECT COUNT(*) as count FROM profile_assessments').get(),
            gapAnalyses: db.prepare('SELECT COUNT(*) as count FROM gap_analyses').get(),
            priorityMatrices: db.prepare('SELECT COUNT(*) as count FROM priority_matrices').get(),
            implementationPlans: db.prepare('SELECT COUNT(*) as count FROM implementation_plans').get(),
            costEstimates: db.prepare('SELECT COUNT(*) as count FROM cost_estimates').get(),
            milestones: db.prepare('SELECT COUNT(*) as count FROM milestones').get(),
            auditTrail: db.prepare('SELECT COUNT(*) as count FROM audit_trail').get(),
            reports: db.prepare('SELECT COUNT(*) as count FROM reports').get(),
            evidence: db.prepare('SELECT COUNT(*) as count FROM evidence').get(),
            questionResponses: db.prepare('SELECT COUNT(*) as count FROM question_responses').get()
        };
        // Execute deletion in transaction to ensure atomicity
        const deleteResult = db.transaction(() => {
            // Delete in proper order to respect foreign key constraints
            // 1. Delete question responses (references profiles)
            const deletedQuestionResponses = db.prepare('DELETE FROM question_responses').run();
            // 2. Delete evidence (references profile_assessments)
            const deletedEvidence = db.prepare('DELETE FROM evidence').run();
            // 3. Delete reports (references profiles/organizations)
            const deletedReports = db.prepare('DELETE FROM reports').run();
            // 4. Delete audit trail (references profiles/organizations)
            const deletedAuditTrail = db.prepare('DELETE FROM audit_trail').run();
            // 5. Delete milestones (references profiles)
            const deletedMilestones = db.prepare('DELETE FROM milestones').run();
            // 6. Delete cost estimates (references profiles)
            const deletedCostEstimates = db.prepare('DELETE FROM cost_estimates').run();
            // 7. Delete implementation plans (references profiles)
            const deletedImplementationPlans = db.prepare('DELETE FROM implementation_plans').run();
            // 8. Delete priority matrices (references profiles)
            const deletedPriorityMatrices = db.prepare('DELETE FROM priority_matrices').run();
            // 9. Delete gap analyses (references profiles)
            const deletedGapAnalyses = db.prepare('DELETE FROM gap_analyses').run();
            // 10. Delete profile assessments (references profiles)
            const deletedAssessments = db.prepare('DELETE FROM profile_assessments').run();
            // 11. Delete profiles (references organization_profiles)
            const deletedProfiles = db.prepare('DELETE FROM profiles').run();
            // 12. Delete organization profiles (root organizational data)
            const deletedOrganizations = db.prepare('DELETE FROM organization_profiles').run();
            return {
                questionResponses: deletedQuestionResponses.changes,
                evidence: deletedEvidence.changes,
                reports: deletedReports.changes,
                auditTrail: deletedAuditTrail.changes,
                milestones: deletedMilestones.changes,
                costEstimates: deletedCostEstimates.changes,
                implementationPlans: deletedImplementationPlans.changes,
                priorityMatrices: deletedPriorityMatrices.changes,
                gapAnalyses: deletedGapAnalyses.changes,
                assessments: deletedAssessments.changes,
                profiles: deletedProfiles.changes,
                organizations: deletedOrganizations.changes
            };
        });
        // Verify framework data is still intact
        const frameworkVerification = {
            functions: db.prepare('SELECT COUNT(*) as count FROM functions').get(),
            categories: db.prepare('SELECT COUNT(*) as count FROM categories').get(),
            subcategories: db.prepare('SELECT COUNT(*) as count FROM subcategories').get(),
            implementationExamples: db.prepare('SELECT COUNT(*) as count FROM implementation_examples').get(),
            questionBank: db.prepare('SELECT COUNT(*) as count FROM question_bank').get(),
            questionOptions: db.prepare('SELECT COUNT(*) as count FROM question_options').get(),
            questionExamples: db.prepare('SELECT COUNT(*) as count FROM question_examples').get(),
            questionContext: db.prepare('SELECT COUNT(*) as count FROM question_context').get()
        };
        const summary = {
            operation: 'reset_organizational_data',
            status: 'completed',
            timestamp: new Date().toISOString(),
            deleted_records: {
                organizations: deleteResult.organizations,
                profiles: deleteResult.profiles,
                assessments: deleteResult.assessments,
                gap_analyses: deleteResult.gapAnalyses,
                priority_matrices: deleteResult.priorityMatrices,
                implementation_plans: deleteResult.implementationPlans,
                cost_estimates: deleteResult.costEstimates,
                milestones: deleteResult.milestones,
                audit_trail: deleteResult.auditTrail,
                reports: deleteResult.reports,
                evidence: deleteResult.evidence,
                question_responses: deleteResult.questionResponses,
                total: Object.values(deleteResult).reduce((sum, count) => sum + count, 0)
            },
            before_counts: beforeCounts,
            framework_data_preserved: {
                functions: frameworkVerification.functions.count,
                categories: frameworkVerification.categories.count,
                subcategories: frameworkVerification.subcategories.count,
                implementation_examples: frameworkVerification.implementationExamples.count,
                question_bank: frameworkVerification.questionBank.count,
                question_options: frameworkVerification.questionOptions.count,
                question_examples: frameworkVerification.questionExamples.count,
                question_context: frameworkVerification.questionContext.count
            },
            warnings: [
                'All organizational profiles have been permanently deleted',
                'All assessment data has been permanently deleted',
                'All reports and analyses have been permanently deleted',
                'This action cannot be undone',
                'NIST CSF framework data and question bank remain intact'
            ]
        };
        logger.warn('Organizational data reset completed', {
            operation: 'reset_organizational_data',
            deleted_records: summary.deleted_records,
            framework_preserved: summary.framework_data_preserved
        });
        return {
            success: true,
            data: summary
        };
    }
    catch (error) {
        logger.error('Failed to reset organizational data', {
            operation: 'reset_organizational_data',
            error: error instanceof Error ? error.message : 'Unknown error'
        });
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to reset organizational data'
        };
    }
}
export const resetOrganizationalDataTool = {
    name: 'reset_organizational_data',
    description: 'DESTRUCTIVE: Permanently removes ALL organizational profiles, assessments, and related data. Preserves NIST CSF framework data, questions, and baseline information. Requires explicit confirmation.',
    inputSchema: {
        type: 'object',
        properties: {
            confirmation: {
                type: 'string',
                enum: ['CONFIRM_RESET_ALL_ORGANIZATIONAL_DATA'],
                description: 'REQUIRED: Must be exactly "CONFIRM_RESET_ALL_ORGANIZATIONAL_DATA" to proceed with deletion'
            }
        },
        required: ['confirmation']
    }
};

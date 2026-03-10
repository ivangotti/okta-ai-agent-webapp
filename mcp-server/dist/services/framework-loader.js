/**
 * Framework loader service for caching and accessing NIST CSF 2.0 data
 */
import { readFileSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
export class FrameworkLoader {
    frameworkData = null;
    jsonPath;
    // Cached lookups for performance
    functionsCache = new Map();
    categoriesCache = new Map();
    subcategoriesCache = new Map();
    implementationExamplesCache = new Map();
    constructor(jsonPath) {
        this.jsonPath = jsonPath || path.join(process.cwd(), 'data/csf-2.0-framework.json');
    }
    /**
     * Load and parse the framework JSON file
     */
    async load() {
        try {
            logger.info(`Loading CSF framework from: ${this.jsonPath}`);
            const fileContent = readFileSync(this.jsonPath, 'utf-8');
            const parsed = JSON.parse(fileContent);
            this.frameworkData = parsed.response.elements;
            this.buildCaches();
            logger.info(`Framework loaded successfully: ${this.frameworkData.elements.length} elements`);
        }
        catch (error) {
            logger.error('Failed to load framework:', error);
            throw new Error(`Failed to load CSF framework: ${error}`);
        }
    }
    /**
     * Build lookup caches for faster access
     */
    buildCaches() {
        if (!this.frameworkData)
            return;
        this.functionsCache.clear();
        this.categoriesCache.clear();
        this.subcategoriesCache.clear();
        this.implementationExamplesCache.clear();
        for (const element of this.frameworkData.elements) {
            switch (element.element_type) {
                case 'function':
                    this.functionsCache.set(element.element_identifier, element);
                    break;
                case 'category':
                    this.categoriesCache.set(element.element_identifier, element);
                    break;
                case 'subcategory':
                    this.subcategoriesCache.set(element.element_identifier, element);
                    break;
                case 'implementation_example': {
                    // Group implementation examples by their parent subcategory
                    const parentId = this.extractParentSubcategory(element.element_identifier);
                    if (parentId) {
                        const examples = this.implementationExamplesCache.get(parentId) || [];
                        examples.push(element);
                        this.implementationExamplesCache.set(parentId, examples);
                    }
                    break;
                }
            }
        }
        logger.info(`Caches built: ${this.functionsCache.size} functions, ${this.categoriesCache.size} categories, ${this.subcategoriesCache.size} subcategories`);
    }
    /**
     * Extract parent subcategory ID from implementation example ID
     */
    extractParentSubcategory(exampleId) {
        // Format: GV.OC-01.001
        const match = exampleId.match(/^([A-Z]{2}\.[A-Z]{2}-\d{2})\.\d{3}$/);
        return match ? match[1] : null;
    }
    // ============================================================================
    // PUBLIC API
    // ============================================================================
    /**
     * Get all functions
     */
    getFunctions() {
        return Array.from(this.functionsCache.values());
    }
    /**
     * Get a specific function by ID
     */
    getFunction(functionId) {
        return this.functionsCache.get(functionId);
    }
    /**
     * Get all categories for a function
     */
    getCategoriesForFunction(functionId) {
        const categories = [];
        for (const [id, category] of this.categoriesCache) {
            if (id.startsWith(`${functionId}.`)) {
                categories.push(category);
            }
        }
        return categories;
    }
    /**
     * Get a specific category by ID
     */
    getCategory(categoryId) {
        return this.categoriesCache.get(categoryId);
    }
    /**
     * Get all subcategories for a category
     */
    getSubcategoriesForCategory(categoryId) {
        const subcategories = [];
        for (const [id, subcategory] of this.subcategoriesCache) {
            if (id.startsWith(`${categoryId}-`)) {
                subcategories.push(subcategory);
            }
        }
        return subcategories;
    }
    /**
     * Get a specific subcategory by ID
     */
    getSubcategory(subcategoryId) {
        return this.subcategoriesCache.get(subcategoryId);
    }
    /**
     * Get implementation examples for a subcategory
     */
    getImplementationExamples(subcategoryId) {
        return this.implementationExamplesCache.get(subcategoryId) || [];
    }
    /**
     * Search elements by keyword
     */
    searchElements(keyword) {
        if (!this.frameworkData)
            return [];
        const lowerKeyword = keyword.toLowerCase();
        const results = [];
        for (const element of this.frameworkData.elements) {
            const searchText = `${element.element_identifier} ${element.title || ''} ${element.text || ''}`.toLowerCase();
            if (searchText.includes(lowerKeyword)) {
                results.push(element);
            }
        }
        return results;
    }
    /**
     * Get all elements of a specific type
     */
    getElementsByType(elementType) {
        if (!this.frameworkData)
            return [];
        return this.frameworkData.elements.filter(element => element.element_type === elementType);
    }
    /**
     * Get relationships for an element
     */
    getRelationships(elementId) {
        if (!this.frameworkData || !this.frameworkData.relationships)
            return [];
        return this.frameworkData.relationships.filter(rel => rel.source_element_identifier === elementId ||
            rel.dest_element_identifier === elementId);
    }
    /**
     * Get element by ID (any type)
     */
    getElementById(elementId) {
        if (!this.frameworkData)
            return undefined;
        return this.frameworkData.elements.find(element => element.element_identifier === elementId);
    }
    /**
     * Get all documents
     */
    getDocuments() {
        return this.frameworkData?.documents || [];
    }
    /**
     * Get framework statistics
     */
    getStats() {
        if (!this.frameworkData) {
            return {
                loaded: false,
                functions: 0,
                categories: 0,
                subcategories: 0,
                implementationExamples: 0,
                relationships: 0,
                totalElements: 0
            };
        }
        const stats = {
            loaded: true,
            functions: this.functionsCache.size,
            categories: this.categoriesCache.size,
            subcategories: this.subcategoriesCache.size,
            implementationExamples: 0,
            relationships: this.frameworkData.relationships?.length || 0,
            totalElements: this.frameworkData.elements.length
        };
        // Count implementation examples
        for (const examples of this.implementationExamplesCache.values()) {
            stats.implementationExamples += examples.length;
        }
        return stats;
    }
    /**
     * Check if framework is loaded
     */
    isLoaded() {
        return this.frameworkData !== null;
    }
    /**
     * Get the full framework data
     */
    getFrameworkData() {
        return this.frameworkData;
    }
    /**
     * Validate element ID format
     */
    validateElementId(elementId, elementType) {
        switch (elementType) {
            case 'function':
                return /^[A-Z]{2}$/.test(elementId);
            case 'category':
                return /^[A-Z]{2}\.[A-Z]{2}$/.test(elementId);
            case 'subcategory':
                return /^[A-Z]{2}\.[A-Z]{2}-\d{2}$/.test(elementId);
            case 'implementation_example':
                return /^[A-Z]{2}\.[A-Z]{2}-\d{2}\.\d{3}$/.test(elementId) ||
                    elementId === 'first' ||
                    elementId === 'third';
            default:
                return true;
        }
    }
}
// Singleton instance
let loaderInstance = null;
export function getFrameworkLoader(jsonPath) {
    if (!loaderInstance) {
        loaderInstance = new FrameworkLoader(jsonPath);
    }
    return loaderInstance;
}
export async function initializeFramework(jsonPath) {
    const loader = getFrameworkLoader(jsonPath);
    if (!loader.isLoaded()) {
        await loader.load();
    }
    return loader;
}

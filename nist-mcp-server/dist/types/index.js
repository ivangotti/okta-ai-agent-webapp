/**
 * TypeScript type definitions for NIST CSF 2.0 Framework
 */
// ============================================================================
// ENUMS
// ============================================================================
export var CSFFunction;
(function (CSFFunction) {
    CSFFunction["GOVERN"] = "GV";
    CSFFunction["IDENTIFY"] = "ID";
    CSFFunction["PROTECT"] = "PR";
    CSFFunction["DETECT"] = "DE";
    CSFFunction["RESPOND"] = "RS";
    CSFFunction["RECOVER"] = "RC";
})(CSFFunction || (CSFFunction = {}));
export var ElementType;
(function (ElementType) {
    ElementType["FUNCTION"] = "function";
    ElementType["CATEGORY"] = "category";
    ElementType["SUBCATEGORY"] = "subcategory";
    ElementType["IMPLEMENTATION_EXAMPLE"] = "implementation_example";
    ElementType["PARTY"] = "party";
    ElementType["WITHDRAW_REASON"] = "withdraw_reason";
})(ElementType || (ElementType = {}));
export var PartyType;
(function (PartyType) {
    PartyType["FIRST"] = "first";
    PartyType["THIRD"] = "third";
})(PartyType || (PartyType = {}));
export var RelationshipType;
(function (RelationshipType) {
    RelationshipType["PROJECTION"] = "projection";
    RelationshipType["RELATED_TO"] = "related_to";
    RelationshipType["SUPERSEDES"] = "supersedes";
    RelationshipType["INCORPORATED_INTO"] = "incorporated_into";
})(RelationshipType || (RelationshipType = {}));
export var ImplementationTier;
(function (ImplementationTier) {
    ImplementationTier["TIER_1_PARTIAL"] = "Tier 1 - Partial";
    ImplementationTier["TIER_2_RISK_INFORMED"] = "Tier 2 - Risk Informed";
    ImplementationTier["TIER_3_REPEATABLE"] = "Tier 3 - Repeatable";
    ImplementationTier["TIER_4_ADAPTIVE"] = "Tier 4 - Adaptive";
})(ImplementationTier || (ImplementationTier = {}));
// Type guards
export function isFunction(element) {
    return element.element_type === ElementType.FUNCTION;
}
export function isCategory(element) {
    return element.element_type === ElementType.CATEGORY;
}
export function isSubcategory(element) {
    return element.element_type === ElementType.SUBCATEGORY;
}
export function isImplementationExample(element) {
    return element.element_type === ElementType.IMPLEMENTATION_EXAMPLE;
}

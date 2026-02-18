import type { DMMF } from '@prisma/generator-helper';

/**
 * Represents a parsed field from a Prisma model
 */
export interface ParsedField {
  name: string;
  type: string;
  isRequired: boolean;
  isList: boolean;
  isId: boolean;
  isUnique: boolean;
  hasDefaultValue: boolean;
  isRelation: boolean;
}

/**
 * Represents a parsed relation between models
 */
export interface ParsedRelation {
  name: string;
  type: string;
  foreignKey: string[];
  references: string[];
  onDelete: string | null;
  isList: boolean;
  isRequired: boolean;
}

/**
 * Represents a unique constraint from the Prisma schema.
 * Can be either a standalone @unique field or a compound @@unique.
 */
export interface UniqueConstraintInfo {
  /** The fields in the constraint (excluding deleted_at) */
  fields: string[];
  /** Whether deleted_at/deletedAt was part of a compound @@unique */
  includesDeletedAt: boolean;
  /** The compound key name used by Prisma for findUnique where clauses (e.g. "email_deleted_at") */
  compoundKeyName?: string;
}

/**
 * Valid audit actions that can be specified in @audit(action1, action2)
 */
export type AuditAction = 'create' | 'update' | 'delete';

const VALID_AUDIT_ACTIONS: readonly AuditAction[] = ['create', 'update', 'delete'];

/**
 * Shared base for all parsed model variants.
 */
interface ParsedModelBase {
  name: string;
  primaryKey: string | string[];
  fields: ParsedField[];
  relations: ParsedRelation[];
  /** String fields with @unique or part of @@unique that need mangling on soft delete */
  uniqueStringFields: string[];
  /** All fields with @unique or part of @@unique (for partial index warnings) */
  allUniqueFields: string[];
  /** Structured unique constraint info for accurate warning generation */
  uniqueConstraints: UniqueConstraintInfo[];
}

/**
 * A model with a deleted_at field enabling soft-delete behavior.
 * May also be auditable.
 */
export interface SoftDeletableModel extends ParsedModelBase {
  kind: 'soft-deletable';
  isSoftDeletable: true;
  isAuditTable: false;
  deletedAtField: string;
  deletedByField: string | null;
  isAuditable: boolean;
  auditActions: AuditAction[];
}

/**
 * A non-soft-deletable model that is auditable (has @audit annotation).
 */
export interface AuditOnlyModel extends ParsedModelBase {
  kind: 'audit-only';
  isSoftDeletable: false;
  isAuditTable: false;
  deletedAtField: null;
  deletedByField: null;
  isAuditable: true;
  auditActions: AuditAction[];
}

/**
 * The model designated as the audit event table (@audit-table).
 */
export interface AuditTableModel extends ParsedModelBase {
  kind: 'audit-table';
  isSoftDeletable: false;
  isAuditTable: true;
  deletedAtField: null;
  deletedByField: null;
  isAuditable: false;
  auditActions: readonly [];
}

/**
 * A plain model with no soft-delete, audit, or audit-table behavior.
 */
export interface PlainModel extends ParsedModelBase {
  kind: 'plain';
  isSoftDeletable: false;
  isAuditTable: false;
  deletedAtField: null;
  deletedByField: null;
  isAuditable: false;
  auditActions: readonly [];
}

/**
 * Discriminated union of all parsed model variants.
 * Use `model.isSoftDeletable` or `model.kind` to narrow.
 */
export type ParsedModel = SoftDeletableModel | AuditOnlyModel | AuditTableModel | PlainModel;

/**
 * Result of parsing the entire DMMF
 */
export interface ParsedSchema {
  models: ParsedModel[];
  modelMap: Map<string, ParsedModel>;
  /** The model marked with @audit-table, if any */
  auditTable: AuditTableModel | null;
}

const DELETED_AT_FIELD_NAMES: readonly string[] = ['deleted_at', 'deletedAt'];
const DELETED_BY_FIELD_NAMES: readonly string[] = ['deleted_by', 'deletedBy'];

/**
 * Options for customizing DMMF parsing behavior
 */
interface ParseDMMFOptions {
  /** Custom field name for the deleted-at marker (prepended to default candidates) */
  deletedAtField?: string;
  /** Custom field name for the deleted-by marker (prepended to default candidates) */
  deletedByField?: string;
}

/**
 * Type for DMMF field that may be readonly
 */
type DMMFField = DMMF.Field | DMMF.Document['datamodel']['models'][number]['fields'][number];

/**
 * Finds a field matching one of the given candidate names
 */
function findFieldByNames(
  fields: readonly DMMFField[],
  candidates: readonly string[],
): DMMFField | undefined {
  return fields.find((field) => candidates.includes(field.name));
}

/**
 * Determines if a field is suitable as a deleted_at marker.
 * Accepts:
 * - Nullable DateTime (traditional: deleted_at DateTime?)
 * - Non-nullable DateTime with default (sentinel: deleted_at DateTime @default(...))
 */
function isValidDeletedAtField(field: DMMFField): boolean {
  if (field.type !== 'DateTime') return false;
  // Nullable DateTime — traditional mangle/none strategy
  if (!field.isRequired) return true;
  // Non-nullable DateTime with default — sentinel strategy
  if (field.hasDefaultValue) return true;
  return false;
}

/**
 * Determines if a field is suitable as a deleted_by marker
 * Must be String and nullable
 */
function isValidDeletedByField(field: DMMFField): boolean {
  return field.type === 'String' && !field.isRequired;
}

/**
 * Type for DMMF model that may be readonly
 */
type DMMFModel = DMMF.Model | DMMF.Document['datamodel']['models'][number];

/**
 * Extracts the primary key configuration from a DMMF model
 */
function extractPrimaryKey(model: DMMFModel): string | string[] {
  // Check for compound primary key first
  if (model.primaryKey !== null) {
    const pkFields = model.primaryKey.fields;
    if (pkFields.length > 1) {
      return [...pkFields];
    }
    if (pkFields.length === 1 && pkFields[0] !== undefined) {
      return pkFields[0];
    }
  }

  // Fall back to @id field
  const idField = model.fields.find((field) => field.isId);
  if (idField !== undefined) {
    return idField.name;
  }

  // Fall back to @@unique if no @id exists (Prisma allows this)
  if (model.uniqueFields.length > 0) {
    const firstUnique = model.uniqueFields[0];
    if (firstUnique !== undefined && firstUnique.length > 0) {
      return firstUnique.length === 1 ? (firstUnique[0] ?? 'id') : [...firstUnique];
    }
  }

  throw new Error(
    `prisma-safe-delete: Model "${model.name}" has no identifiable primary key (@id, @@id, or @@unique). ` +
    `Every model must have a primary key for soft-delete operations.`,
  );
}

/**
 * Parses a single DMMF field into our ParsedField format
 */
function parseField(field: DMMFField): ParsedField {
  return {
    name: field.name,
    type: field.type,
    isRequired: field.isRequired,
    isList: field.isList,
    isId: field.isId,
    isUnique: field.isUnique,
    hasDefaultValue: field.hasDefaultValue,
    isRelation: field.relationName !== undefined,
  };
}

/**
 * Parses a relation field into our ParsedRelation format
 */
function parseRelation(field: DMMFField): ParsedRelation | null {
  if (field.relationName === undefined) {
    return null;
  }

  const fromFields = field.relationFromFields;
  const toFields = field.relationToFields;

  return {
    name: field.name,
    type: field.type,
    foreignKey: fromFields !== undefined ? [...fromFields] : [],
    references: toFields !== undefined ? [...toFields] : [],
    onDelete: field.relationOnDelete ?? null,
    isList: field.isList,
    isRequired: field.isRequired,
  };
}

/**
 * Checks if a field has a UUID native database type (@db.Uuid).
 * UUID fields should not be mangled since appending text would create invalid UUIDs.
 */
function hasUuidNativeType(field: DMMFField): boolean {
  return field.nativeType?.[0] === 'Uuid';
}

/**
 * Checks if a string field is safe to mangle.
 * Returns true for regular strings, false for UUID native types.
 */
function isMangleableStringField(field: DMMFField): boolean {
  return field.type === 'String' && !hasUuidNativeType(field);
}

/**
 * Extracts unique string fields from a model.
 * Includes both @unique fields and string fields from @@unique compound constraints.
 * Excludes UUID native types since mangling would create invalid UUIDs.
 */
function extractUniqueStringFields(model: DMMFModel): string[] {
  const uniqueStringFields = new Set<string>();

  // Find fields with @unique that are mangeable strings (excludes @db.Uuid)
  for (const field of model.fields) {
    if (field.isUnique && isMangleableStringField(field)) {
      uniqueStringFields.add(field.name);
    }
  }

  // Find mangleable string fields in @@unique compound constraints
  for (const uniqueConstraint of model.uniqueFields) {
    for (const fieldName of uniqueConstraint) {
      const field = model.fields.find((f) => f.name === fieldName);
      if (field !== undefined && isMangleableStringField(field)) {
        uniqueStringFields.add(fieldName);
      }
    }
  }

  // Return sorted for deterministic output (ASCII order, not locale-dependent)
  return [...uniqueStringFields].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Extracts ALL unique fields from a model (not just strings).
 * Used for warning users about partial indexes needed when uniqueStrategy='none'.
 */
function extractAllUniqueFields(model: DMMFModel): string[] {
  const uniqueFields = new Set<string>();

  // Find all fields with @unique (any type)
  for (const field of model.fields) {
    if (field.isUnique && field.relationName === undefined) {
      uniqueFields.add(field.name);
    }
  }

  // Find all fields in @@unique compound constraints
  for (const uniqueConstraint of model.uniqueFields) {
    for (const fieldName of uniqueConstraint) {
      uniqueFields.add(fieldName);
    }
  }

  // Return sorted for deterministic output (ASCII order, not locale-dependent)
  return [...uniqueFields].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Extracts structured unique constraint info from a model.
 * For standalone @unique fields: creates a single-field constraint (skips deleted_at).
 * For compound @@unique: strips deleted_at from fields and flags includesDeletedAt.
 */
function extractUniqueConstraints(
  model: DMMFModel,
  deletedAtFieldName: string | null,
): UniqueConstraintInfo[] {
  const constraints: UniqueConstraintInfo[] = [];

  // Standalone @unique fields
  for (const field of model.fields) {
    if (field.isUnique && field.relationName === undefined) {
      // Skip the deleted_at field itself — it's never meaningful as a unique constraint target
      if (deletedAtFieldName !== null && field.name === deletedAtFieldName) {
        continue;
      }
      constraints.push({ fields: [field.name], includesDeletedAt: false });
    }
  }

  // Compound @@unique constraints — use uniqueIndexes for name, fall back to uniqueFields
  // uniqueIndexes has { name, fields } while uniqueFields is just string[][]
  // This property exists at runtime but is not in the @prisma/generator-helper types
  interface UniqueIndex { name: string | null; fields: string[] }
  const uniqueIndexes = (model as unknown as { uniqueIndexes?: UniqueIndex[] }).uniqueIndexes;

  for (let i = 0; i < model.uniqueFields.length; i++) {
    const uniqueConstraint = model.uniqueFields[i];
    if (uniqueConstraint === undefined) continue;
    const hasDeletedAt =
      deletedAtFieldName !== null &&
      uniqueConstraint.includes(deletedAtFieldName);
    const fieldsWithoutDeletedAt = hasDeletedAt
      ? uniqueConstraint.filter((f) => f !== deletedAtFieldName)
      : [...uniqueConstraint];

    if (fieldsWithoutDeletedAt.length > 0) {
      // Get the compound key name from uniqueIndexes if available
      const indexInfo = uniqueIndexes?.[i];
      const compoundKeyName = indexInfo?.name ?? uniqueConstraint.join('_');

      constraints.push({
        fields: fieldsWithoutDeletedAt,
        includesDeletedAt: hasDeletedAt,
        compoundKeyName,
      });
    }
  }

  return constraints;
}

/**
 * Parses @audit and @audit-table annotations from model documentation.
 * - `@audit` → auditable with all actions
 * - `@audit(create, delete)` → auditable with specific actions
 * - `@audit-table` → this model is the audit event table
 */
function parseAuditAnnotations(documentation: string | undefined): {
  isAuditable: boolean;
  auditActions: AuditAction[];
  isAuditTable: boolean;
} {
  if (documentation === undefined) {
    return { isAuditable: false, auditActions: [], isAuditTable: false };
  }

  const isAuditTable = /@audit-table\b/.test(documentation);

  // Match @audit or @audit(actions) — but NOT @audit-table
  const auditMatch = /@audit(?!\s*-table)(?:\(([^)]+)\))?/.exec(documentation);
  if (auditMatch === null) {
    return { isAuditable: false, auditActions: [], isAuditTable };
  }

  const actionStr = auditMatch[1];
  if (actionStr === undefined) {
    // @audit with no args → all actions
    return { isAuditable: true, auditActions: [...VALID_AUDIT_ACTIONS], isAuditTable };
  }

  // Parse comma-separated actions
  const actions = actionStr
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AuditAction => (VALID_AUDIT_ACTIONS as readonly string[]).includes(s));

  return { isAuditable: actions.length > 0, auditActions: actions, isAuditTable };
}

/**
 * Parses a single DMMF model into our ParsedModel format
 */
function parseModel(model: DMMFModel, options?: ParseDMMFOptions): ParsedModel {
  const customDeletedAtField = options?.deletedAtField;
  const deletedAtCandidates = customDeletedAtField !== undefined
    ? [customDeletedAtField, ...DELETED_AT_FIELD_NAMES]
    : DELETED_AT_FIELD_NAMES;
  const customDeletedByField = options?.deletedByField;
  const deletedByCandidates = customDeletedByField !== undefined
    ? [customDeletedByField, ...DELETED_BY_FIELD_NAMES]
    : DELETED_BY_FIELD_NAMES;

  const deletedAtCandidate = findFieldByNames(
    model.fields,
    deletedAtCandidates,
  );
  const deletedByCandidate = findFieldByNames(
    model.fields,
    deletedByCandidates,
  );

  const deletedAtField =
    deletedAtCandidate !== undefined && isValidDeletedAtField(deletedAtCandidate)
      ? deletedAtCandidate.name
      : null;

  const deletedByField =
    deletedByCandidate !== undefined && isValidDeletedByField(deletedByCandidate)
      ? deletedByCandidate.name
      : null;

  const fields: ParsedField[] = [];
  for (const field of model.fields) {
    fields.push(parseField(field));
  }

  const relations: ParsedRelation[] = [];
  for (const field of model.fields) {
    const relation = parseRelation(field);
    if (relation !== null) {
      relations.push(relation);
    }
  }

  // Parse @audit and @audit-table annotations from model documentation (/// comments)
  const doc = (model as unknown as { documentation?: string }).documentation;
  const audit = parseAuditAnnotations(doc);

  // Shared base properties
  const base: ParsedModelBase = {
    name: model.name,
    primaryKey: extractPrimaryKey(model),
    fields,
    relations,
    uniqueStringFields: extractUniqueStringFields(model),
    allUniqueFields: extractAllUniqueFields(model),
    uniqueConstraints: extractUniqueConstraints(model, deletedAtField),
  };

  // Determine variant via if/else chain: audit-table → soft-deletable → audit-only → plain
  if (audit.isAuditTable) {
    return {
      ...base,
      kind: 'audit-table',
      isSoftDeletable: false,
      isAuditTable: true,
      deletedAtField: null,
      deletedByField: null,
      isAuditable: false,
      auditActions: [],
    };
  }

  if (deletedAtField !== null) {
    return {
      ...base,
      kind: 'soft-deletable',
      isSoftDeletable: true,
      isAuditTable: false,
      deletedAtField,
      deletedByField,
      isAuditable: audit.isAuditable,
      auditActions: audit.isAuditable ? audit.auditActions : [],
    };
  }

  if (audit.isAuditable) {
    return {
      ...base,
      kind: 'audit-only',
      isSoftDeletable: false,
      isAuditTable: false,
      deletedAtField: null,
      deletedByField: null,
      isAuditable: true,
      auditActions: audit.auditActions,
    };
  }

  return {
    ...base,
    kind: 'plain',
    isSoftDeletable: false,
    isAuditTable: false,
    deletedAtField: null,
    deletedByField: null,
    isAuditable: false,
    auditActions: [],
  };
}

/**
 * Parses the complete DMMF datamodel into our structured format
 *
 * @param dmmf - The DMMF document from Prisma generator
 * @param options - Optional configuration for custom field name detection
 * @returns ParsedSchema with models array and lookup map
 */
export function parseDMMF(dmmf: DMMF.Document, options?: ParseDMMFOptions): ParsedSchema {
  const models: ParsedModel[] = [];
  for (const model of dmmf.datamodel.models) {
    models.push(parseModel(model, options));
  }

  const modelMap = new Map<string, ParsedModel>();

  for (const model of models) {
    modelMap.set(model.name, model);
  }

  // Find the audit table model (at most one should be marked @audit-table)
  const auditTables = models.filter((m): m is AuditTableModel => m.isAuditTable);
  const auditTable = auditTables.length === 1 ? (auditTables[0] ?? null) : null;

  return { models, modelMap, auditTable };
}

/**
 * Gets all soft-deletable models from a parsed schema
 */
export function getSoftDeletableModels(schema: ParsedSchema): SoftDeletableModel[] {
  return schema.models.filter((model): model is SoftDeletableModel => model.isSoftDeletable);
}

/**
 * Gets all non-soft-deletable models from a parsed schema
 */
export function getHardDeleteOnlyModels(
  schema: ParsedSchema,
): (AuditOnlyModel | AuditTableModel | PlainModel)[] {
  return schema.models.filter(
    (model): model is AuditOnlyModel | AuditTableModel | PlainModel => !model.isSoftDeletable,
  );
}

/**
 * Gets all auditable models from a parsed schema
 */
export function getAuditableModels(schema: ParsedSchema): (SoftDeletableModel | AuditOnlyModel)[] {
  return schema.models.filter(
    (model): model is SoftDeletableModel | AuditOnlyModel => model.isAuditable,
  );
}

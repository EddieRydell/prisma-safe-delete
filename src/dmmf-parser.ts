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
}

/**
 * Represents a fully parsed Prisma model
 */
export interface ParsedModel {
  name: string;
  primaryKey: string | string[];
  isSoftDeletable: boolean;
  deletedAtField: string | null;
  deletedByField: string | null;
  fields: ParsedField[];
  relations: ParsedRelation[];
  /** String fields with @unique or part of @@unique that need mangling on soft delete */
  uniqueStringFields: string[];
}

/**
 * Result of parsing the entire DMMF
 */
export interface ParsedSchema {
  models: ParsedModel[];
  modelMap: Map<string, ParsedModel>;
}

const DELETED_AT_FIELD_NAMES: readonly string[] = ['deleted_at', 'deletedAt'];
const DELETED_BY_FIELD_NAMES: readonly string[] = ['deleted_by', 'deletedBy'];

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
 * Determines if a field is suitable as a deleted_at marker
 * Must be DateTime and nullable
 */
function isValidDeletedAtField(field: DMMFField): boolean {
  return field.type === 'DateTime' && !field.isRequired;
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

  return 'id';
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

  // Return sorted for deterministic output
  return [...uniqueStringFields].sort();
}

/**
 * Parses a single DMMF model into our ParsedModel format
 */
function parseModel(model: DMMFModel): ParsedModel {
  const deletedAtCandidate = findFieldByNames(
    model.fields,
    DELETED_AT_FIELD_NAMES,
  );
  const deletedByCandidate = findFieldByNames(
    model.fields,
    DELETED_BY_FIELD_NAMES,
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

  return {
    name: model.name,
    primaryKey: extractPrimaryKey(model),
    isSoftDeletable: deletedAtField !== null,
    deletedAtField,
    deletedByField,
    fields,
    relations,
    uniqueStringFields: extractUniqueStringFields(model),
  };
}

/**
 * Parses the complete DMMF datamodel into our structured format
 *
 * @param dmmf - The DMMF document from Prisma generator
 * @returns ParsedSchema with models array and lookup map
 */
export function parseDMMF(dmmf: DMMF.Document): ParsedSchema {
  const models: ParsedModel[] = [];
  for (const model of dmmf.datamodel.models) {
    models.push(parseModel(model));
  }

  const modelMap = new Map<string, ParsedModel>();

  for (const model of models) {
    modelMap.set(model.name, model);
  }

  return { models, modelMap };
}

/**
 * Gets all soft-deletable models from a parsed schema
 */
export function getSoftDeletableModels(schema: ParsedSchema): ParsedModel[] {
  return schema.models.filter((model) => model.isSoftDeletable);
}

/**
 * Gets all non-soft-deletable models from a parsed schema
 */
export function getHardDeleteOnlyModels(schema: ParsedSchema): ParsedModel[] {
  return schema.models.filter((model) => !model.isSoftDeletable);
}

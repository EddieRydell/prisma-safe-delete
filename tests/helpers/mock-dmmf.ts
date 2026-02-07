import type { DMMF } from '@prisma/generator-helper';

/**
 * Creates a mock DMMF field with sensible defaults
 */
export function createMockField(
  overrides: Partial<DMMF.Field> & { name: string; type: string },
): DMMF.Field {
  const { name, type, ...rest } = overrides;
  return {
    name,
    type,
    kind: 'scalar',
    isList: false,
    isRequired: true,
    isUnique: false,
    isId: false,
    isReadOnly: false,
    hasDefaultValue: false,
    isGenerated: false,
    isUpdatedAt: false,
    ...rest,
  };
}

/**
 * Creates a mock DMMF model with sensible defaults
 */
export function createMockModel(
  overrides: Partial<DMMF.Model> & { name: string; fields: DMMF.Field[] },
): DMMF.Model {
  const { name, fields, ...rest } = overrides;
  return {
    name,
    fields,
    dbName: null,
    schema: null,
    primaryKey: null,
    uniqueFields: [],
    uniqueIndexes: [],
    isGenerated: false,
    ...rest,
  };
}

/**
 * Creates a mock DMMF Document with sensible defaults
 */
export function createMockDMMF(models: DMMF.Model[]): DMMF.Document {
  return {
    datamodel: {
      models,
      enums: [],
      types: [],
      indexes: [],
    },
    schema: {
      inputObjectTypes: { prisma: [] },
      outputObjectTypes: { prisma: [], model: [] },
      enumTypes: { prisma: [] },
      fieldRefTypes: { prisma: [] },
    },
    mappings: {
      modelOperations: [],
      otherOperations: { read: [], write: [] },
    },
  };
}

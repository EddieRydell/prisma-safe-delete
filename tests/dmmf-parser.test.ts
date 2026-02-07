import { describe, it, expect } from 'vitest';
import type { DMMF } from '@prisma/generator-helper';
import {
  parseDMMF,
  getSoftDeletableModels,
  getHardDeleteOnlyModels,
  type ParsedModel,
} from '../src/dmmf-parser.js';

function createMockField(
  overrides: Partial<DMMF.Field> & { name: string; type: string },
): DMMF.Field {
  return {
    name: overrides.name,
    kind: overrides.kind ?? 'scalar',
    isList: overrides.isList ?? false,
    isRequired: overrides.isRequired ?? true,
    isUnique: overrides.isUnique ?? false,
    isId: overrides.isId ?? false,
    isReadOnly: overrides.isReadOnly ?? false,
    hasDefaultValue: overrides.hasDefaultValue ?? false,
    type: overrides.type,
    isGenerated: overrides.isGenerated ?? false,
    isUpdatedAt: overrides.isUpdatedAt ?? false,
    ...overrides,
  };
}

function createMockModel(
  overrides: Partial<DMMF.Model> & { name: string; fields: DMMF.Field[] },
): DMMF.Model {
  return {
    name: overrides.name,
    dbName: overrides.dbName ?? null,
    fields: overrides.fields,
    primaryKey: overrides.primaryKey ?? null,
    uniqueFields: overrides.uniqueFields ?? [],
    uniqueIndexes: overrides.uniqueIndexes ?? [],
    isGenerated: overrides.isGenerated ?? false,
  };
}

function createMockDMMF(models: DMMF.Model[]): DMMF.Document {
  return {
    datamodel: {
      models,
      enums: [],
      types: [],
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

describe('parseDMMF', () => {
  it('parses a simple model with @id field', () => {
    const model = createMockModel({
      name: 'User',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({ name: 'email', type: 'String', isUnique: true }),
        createMockField({ name: 'name', type: 'String', isRequired: false }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    expect(result.models).toHaveLength(1);
    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.name).toBe('User');
    expect(parsedModel.primaryKey).toBe('id');
    expect(parsedModel.isSoftDeletable).toBe(false);
    expect(parsedModel.deletedAtField).toBeNull();
    expect(parsedModel.fields).toHaveLength(3);
  });

  it('detects soft-deletable model with deleted_at field', () => {
    const model = createMockModel({
      name: 'Post',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({ name: 'title', type: 'String' }),
        createMockField({
          name: 'deleted_at',
          type: 'DateTime',
          isRequired: false,
        }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.isSoftDeletable).toBe(true);
    expect(parsedModel.deletedAtField).toBe('deleted_at');
  });

  it('detects soft-deletable model with deletedAt field (camelCase)', () => {
    const model = createMockModel({
      name: 'Post',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({
          name: 'deletedAt',
          type: 'DateTime',
          isRequired: false,
        }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.isSoftDeletable).toBe(true);
    expect(parsedModel.deletedAtField).toBe('deletedAt');
  });

  it('detects deleted_by field', () => {
    const model = createMockModel({
      name: 'Post',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({
          name: 'deleted_at',
          type: 'DateTime',
          isRequired: false,
        }),
        createMockField({
          name: 'deleted_by',
          type: 'String',
          isRequired: false,
        }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.deletedByField).toBe('deleted_by');
  });

  it('rejects deleted_at field if not DateTime type', () => {
    const model = createMockModel({
      name: 'Post',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({
          name: 'deleted_at',
          type: 'String',
          isRequired: false,
        }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.isSoftDeletable).toBe(false);
    expect(parsedModel.deletedAtField).toBeNull();
  });

  it('rejects deleted_at field if required', () => {
    const model = createMockModel({
      name: 'Post',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({
          name: 'deleted_at',
          type: 'DateTime',
          isRequired: true,
        }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.isSoftDeletable).toBe(false);
  });

  it('parses compound primary key', () => {
    const model = createMockModel({
      name: 'TenantResource',
      fields: [
        createMockField({ name: 'tenantId', type: 'String' }),
        createMockField({ name: 'resourceId', type: 'String' }),
        createMockField({ name: 'data', type: 'String' }),
      ],
      primaryKey: {
        name: null,
        fields: ['tenantId', 'resourceId'],
      },
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.primaryKey).toEqual(['tenantId', 'resourceId']);
  });

  it('parses relations with onDelete cascade', () => {
    const model = createMockModel({
      name: 'Post',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({ name: 'authorId', type: 'String' }),
        createMockField({
          name: 'author',
          type: 'User',
          kind: 'object',
          relationName: 'UserPosts',
          relationFromFields: ['authorId'],
          relationToFields: ['id'],
          relationOnDelete: 'Cascade',
        }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.relations).toHaveLength(1);
    const relation = parsedModel.relations[0];
    expect(relation?.name).toBe('author');
    expect(relation?.type).toBe('User');
    expect(relation?.foreignKey).toEqual(['authorId']);
    expect(relation?.references).toEqual(['id']);
    expect(relation?.onDelete).toBe('Cascade');
  });

  it('creates model map for quick lookups', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [createMockField({ name: 'id', type: 'String', isId: true })],
      }),
      createMockModel({
        name: 'Post',
        fields: [createMockField({ name: 'id', type: 'String', isId: true })],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const result = parseDMMF(dmmf);

    expect(result.modelMap.size).toBe(2);
    expect(result.modelMap.get('User')?.name).toBe('User');
    expect(result.modelMap.get('Post')?.name).toBe('Post');
    expect(result.modelMap.get('NonExistent')).toBeUndefined();
  });
});

describe('getSoftDeletableModels', () => {
  it('filters to only soft-deletable models', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
      createMockModel({
        name: 'AuditLog',
        fields: [createMockField({ name: 'id', type: 'String', isId: true })],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const softDeletable = getSoftDeletableModels(schema);

    expect(softDeletable).toHaveLength(1);
    expect(softDeletable[0]?.name).toBe('User');
  });
});

describe('getHardDeleteOnlyModels', () => {
  it('filters to only non-soft-deletable models', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
      createMockModel({
        name: 'AuditLog',
        fields: [createMockField({ name: 'id', type: 'String', isId: true })],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const hardDeleteOnly = getHardDeleteOnlyModels(schema);

    expect(hardDeleteOnly).toHaveLength(1);
    expect(hardDeleteOnly[0]?.name).toBe('AuditLog');
  });
});

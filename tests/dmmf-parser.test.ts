import { describe, it, expect } from 'vitest';
import {
  parseDMMF,
  getSoftDeletableModels,
  getHardDeleteOnlyModels,
  type ParsedModel,
} from '../src/dmmf-parser.js';
import { createMockField, createMockModel, createMockDMMF } from './helpers/mock-dmmf.js';

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

describe('uniqueStringFields', () => {
  it('includes regular string fields with @unique', () => {
    const model = createMockModel({
      name: 'User',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({ name: 'email', type: 'String', isUnique: true }),
        createMockField({ name: 'name', type: 'String' }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    expect(parsedModel.uniqueStringFields).toEqual(['email']);
  });

  it('excludes UUID native type fields from mangling', () => {
    const model = createMockModel({
      name: 'Membership',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({
          name: 'organization_id',
          type: 'String',
          isUnique: true,
          nativeType: ['Uuid', []],
        }),
        createMockField({ name: 'email', type: 'String', isUnique: true }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    // organization_id should be excluded because it has @db.Uuid
    // email should be included because it's a regular string
    expect(parsedModel.uniqueStringFields).toEqual(['email']);
  });

  it('excludes UUID fields from @@unique compound constraints', () => {
    const model = createMockModel({
      name: 'TenantResource',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({
          name: 'tenant_id',
          type: 'String',
          nativeType: ['Uuid', []],
        }),
        createMockField({ name: 'resource_name', type: 'String' }),
      ],
      uniqueFields: [['tenant_id', 'resource_name']],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    // tenant_id should be excluded (UUID), resource_name should be included
    expect(parsedModel.uniqueStringFields).toEqual(['resource_name']);
  });

  it('handles model with only UUID unique fields', () => {
    const model = createMockModel({
      name: 'Reference',
      fields: [
        createMockField({ name: 'id', type: 'String', isId: true }),
        createMockField({
          name: 'external_id',
          type: 'String',
          isUnique: true,
          nativeType: ['Uuid', []],
        }),
      ],
    });

    const dmmf = createMockDMMF([model]);
    const result = parseDMMF(dmmf);

    const parsedModel = result.models[0] as ParsedModel;
    // No fields should be mangled since the only unique string is a UUID
    expect(parsedModel.uniqueStringFields).toEqual([]);
  });
});

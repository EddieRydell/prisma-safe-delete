import { describe, it, expect } from 'vitest';
import {
  collectModelsWithUniqueFields,
  buildUniqueStrategyWarningLines,
  buildSentinelWarningLines,
  type UniqueFieldInfo,
} from '../src/generator.js';
import { parseDMMF } from '../src/dmmf-parser.js';
import { createMockField, createMockModel, createMockDMMF } from './helpers/mock-dmmf.js';

describe('collectModelsWithUniqueFields', () => {
  it('returns empty array when no models have unique fields', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'name', type: 'String' }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toEqual([]);
  });

  it('returns empty array when model is not soft-deletable', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          // No deleted_at field
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toEqual([]);
  });

  it('collects standalone @unique fields into constraintsNeedingIndexes', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      model: 'User',
      deletedAtField: 'deleted_at',
      constraintsNeedingIndexes: [{ fields: ['email'], includesDeletedAt: false }],
      compoundWithDeletedAt: [],
    });
  });

  it('collects multiple standalone @unique fields', () => {
    const models = [
      createMockModel({
        name: 'Customer',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          createMockField({ name: 'username', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    expect(result[0]!.constraintsNeedingIndexes).toEqual([
      { fields: ['email'], includesDeletedAt: false },
      { fields: ['username'], includesDeletedAt: false },
    ]);
    expect(result[0]!.compoundWithDeletedAt).toEqual([]);
  });

  it('collects from multiple models', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
      createMockModel({
        name: 'Order',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'orderNumber', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.model)).toContain('User');
    expect(result.map((r) => r.model)).toContain('Order');
  });

  it('handles camelCase deletedAt field', () => {
    const models = [
      createMockModel({
        name: 'Article',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'slug', type: 'String', isUnique: true }),
          createMockField({ name: 'deletedAt', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    expect(result[0]!.deletedAtField).toBe('deletedAt');
  });

  it('includes non-string unique fields (Int, UUID, etc.)', () => {
    const models = [
      createMockModel({
        name: 'Employee',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          createMockField({ name: 'employeeNumber', type: 'Int', isUnique: true }),
          createMockField({ name: 'externalId', type: 'String', isUnique: true, nativeType: ['Uuid', []] }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    const fields = result[0]!.constraintsNeedingIndexes.flatMap((c) => c.fields);
    expect(fields).toContain('email');
    expect(fields).toContain('employeeNumber');
    expect(fields).toContain('externalId');
  });

  it('detects @@unique([org_id, name, deleted_at]) in compoundWithDeletedAt', () => {
    const models = [
      createMockModel({
        name: 'Tenant',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'org_id', type: 'String' }),
          createMockField({ name: 'name', type: 'String' }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
        uniqueFields: [['org_id', 'name', 'deleted_at']],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    expect(result[0]!.compoundWithDeletedAt).toEqual([
      { fields: ['org_id', 'name'], includesDeletedAt: true, compoundKeyName: 'org_id_name_deleted_at' },
    ]);
    expect(result[0]!.constraintsNeedingIndexes).toEqual([]);
  });

  it('detects @@unique([org_id, name]) without deleted_at in constraintsNeedingIndexes', () => {
    const models = [
      createMockModel({
        name: 'Tenant',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'org_id', type: 'String' }),
          createMockField({ name: 'name', type: 'String' }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
        uniqueFields: [['org_id', 'name']],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    expect(result[0]!.constraintsNeedingIndexes).toEqual([
      { fields: ['org_id', 'name'], includesDeletedAt: false, compoundKeyName: 'org_id_name' },
    ]);
    expect(result[0]!.compoundWithDeletedAt).toEqual([]);
  });

  it('correctly separates both patterns on the same model', () => {
    const models = [
      createMockModel({
        name: 'Resource',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'slug', type: 'String', isUnique: true }),
          createMockField({ name: 'org_id', type: 'String' }),
          createMockField({ name: 'name', type: 'String' }),
          createMockField({ name: 'tenant_id', type: 'String' }),
          createMockField({ name: 'code', type: 'String' }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
        uniqueFields: [
          ['org_id', 'name', 'deleted_at'], // compound with deleted_at
          ['tenant_id', 'code'],             // compound without deleted_at
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    expect(result[0]!.constraintsNeedingIndexes).toEqual([
      { fields: ['slug'], includesDeletedAt: false },
      { fields: ['tenant_id', 'code'], includesDeletedAt: false, compoundKeyName: 'tenant_id_code' },
    ]);
    expect(result[0]!.compoundWithDeletedAt).toEqual([
      { fields: ['org_id', 'name'], includesDeletedAt: true, compoundKeyName: 'org_id_name_deleted_at' },
    ]);
  });

  it('handles camelCase deletedAt in compound @@unique', () => {
    const models = [
      createMockModel({
        name: 'Article',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'orgId', type: 'String' }),
          createMockField({ name: 'slug', type: 'String' }),
          createMockField({ name: 'deletedAt', type: 'DateTime', isRequired: false }),
        ],
        uniqueFields: [['orgId', 'slug', 'deletedAt']],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    expect(result[0]!.compoundWithDeletedAt).toEqual([
      { fields: ['orgId', 'slug'], includesDeletedAt: true, compoundKeyName: 'orgId_slug_deletedAt' },
    ]);
  });

  it('@@unique with only deleted_at produces no constraint (empty fields)', () => {
    // Degenerate case: @@unique([deleted_at]) — after stripping deleted_at, fields is empty
    const models = [
      createMockModel({
        name: 'Weird',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
        uniqueFields: [['deleted_at']],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    // Empty fields means no useful constraint → should not appear at all
    expect(result).toEqual([]);
  });

  it('standalone @unique on deleted_at field itself is skipped', () => {
    // deleted_at having @unique on it is meaningless for warnings
    const models = [
      createMockModel({
        name: 'Unusual',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false, isUnique: true }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    // deleted_at itself having @unique should not trigger warnings
    expect(result).toEqual([]);
  });

  it('relation fields with @unique are excluded from constraints', () => {
    // Fields with relationName are relation markers, not real unique fields
    const models = [
      createMockModel({
        name: 'Profile',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'user',
            type: 'User',
            kind: 'object',
            isUnique: true,
            relationName: 'ProfileUser',
          }),
          createMockField({ name: 'userId', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = collectModelsWithUniqueFields(schema);

    expect(result).toHaveLength(1);
    // Only userId should appear, not the relation field 'user'
    const fields = result[0]!.constraintsNeedingIndexes.flatMap((c) => c.fields);
    expect(fields).toContain('userId');
    expect(fields).not.toContain('user');
  });
});

describe('buildUniqueStrategyWarningLines', () => {
  it('returns empty array when no models provided', () => {
    const result = buildUniqueStrategyWarningLines([]);
    expect(result).toEqual([]);
  });

  it('includes warning header', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'User',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [{ fields: ['email'], includesDeletedAt: false }],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(result.some((line) => line.includes("uniqueStrategy is 'none'"))).toBe(true);
    expect(result.some((line) => line.includes('partial unique indexes'))).toBe(true);
  });

  it('lists models and fields for constraintsNeedingIndexes', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'User',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [{ fields: ['email'], includesDeletedAt: false }],
        compoundWithDeletedAt: [],
      },
      {
        model: 'Customer',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [
          { fields: ['email'], includesDeletedAt: false },
          { fields: ['username'], includesDeletedAt: false },
        ],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(result.some((line) => line.includes('User: email'))).toBe(true);
    expect(result.some((line) => line.includes('Customer: email, username'))).toBe(true);
  });

  it('generates correct SQL for standalone @unique fields', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'User',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [{ fields: ['email'], includesDeletedAt: false }],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) =>
        line.includes('CREATE UNIQUE INDEX user_email_active ON "User"(email) WHERE deleted_at IS NULL')
      )
    ).toBe(true);
  });

  it('generates compound SQL for compound @@unique constraints without deleted_at', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Tenant',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [{ fields: ['org_id', 'name'], includesDeletedAt: false }],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) =>
        line.includes('CREATE UNIQUE INDEX tenant_org_id_name_active ON "Tenant"(org_id, name) WHERE deleted_at IS NULL')
      )
    ).toBe(true);
  });

  it('shows compound constraints with parens in model listing', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Tenant',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [
          { fields: ['slug'], includesDeletedAt: false },
          { fields: ['org_id', 'name'], includesDeletedAt: false },
        ],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(result.some((line) => line.includes('Tenant: slug, (org_id, name)'))).toBe(true);
  });

  it('generates SQL for multiple standalone fields', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Customer',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [
          { fields: ['email'], includesDeletedAt: false },
          { fields: ['username'], includesDeletedAt: false },
        ],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) => line.includes('customer_email_active'))
    ).toBe(true);
    expect(
      result.some((line) => line.includes('customer_username_active'))
    ).toBe(true);
  });

  it('uses correct deletedAt field name in SQL', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Article',
        deletedAtField: 'deletedAt',
        constraintsNeedingIndexes: [{ fields: ['slug'], includesDeletedAt: false }],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) => line.includes('WHERE deletedAt IS NULL'))
    ).toBe(true);
  });

  it('includes footer warning about consequences', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'User',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [{ fields: ['email'], includesDeletedAt: false }],
        compoundWithDeletedAt: [],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) => line.includes('soft-deleted records will block new records'))
    ).toBe(true);
  });

  it('produces loud NULL warning for compoundWithDeletedAt', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Tenant',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [],
        compoundWithDeletedAt: [{ fields: ['org_id', 'name'], includesDeletedAt: true }],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(result.some((line) => line.includes('NULL != NULL'))).toBe(true);
    expect(
      result.some((line) => line.includes('do NOT enforce uniqueness on active records'))
    ).toBe(true);
  });

  it('mentions NULLS NOT DISTINCT for compoundWithDeletedAt', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Tenant',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [],
        compoundWithDeletedAt: [{ fields: ['org_id', 'name'], includesDeletedAt: true }],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(result.some((line) => line.includes('NULLS NOT DISTINCT'))).toBe(true);
    expect(result.some((line) => line.includes('PostgreSQL 15+'))).toBe(true);
  });

  it('generates correct SQL for compoundWithDeletedAt (deleted_at excluded from columns)', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Tenant',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [],
        compoundWithDeletedAt: [{ fields: ['org_id', 'name'], includesDeletedAt: true }],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) =>
        line.includes('CREATE UNIQUE INDEX tenant_org_id_name_active ON "Tenant"(org_id, name) WHERE deleted_at IS NULL')
      )
    ).toBe(true);
    // deleted_at should NOT appear in the index columns
    expect(
      result.some((line) =>
        line.includes('ON "Tenant"(org_id, name, deleted_at)')
      )
    ).toBe(false);
  });

  it('shows both sections when model has both patterns', () => {
    const models: UniqueFieldInfo[] = [
      {
        model: 'Resource',
        deletedAtField: 'deleted_at',
        constraintsNeedingIndexes: [{ fields: ['slug'], includesDeletedAt: false }],
        compoundWithDeletedAt: [{ fields: ['org_id', 'name'], includesDeletedAt: true }],
      },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    // Section 1: NULL warning
    expect(result.some((line) => line.includes('NULL != NULL'))).toBe(true);
    // Section 1: SQL for compound with deleted_at
    expect(
      result.some((line) =>
        line.includes('resource_org_id_name_active ON "Resource"(org_id, name)')
      )
    ).toBe(true);
    // Section 2: Model listing
    expect(result.some((line) => line.includes('Resource: slug'))).toBe(true);
    // Section 2: SQL for standalone
    expect(
      result.some((line) =>
        line.includes('resource_slug_active ON "Resource"(slug)')
      )
    ).toBe(true);
  });
});

describe('buildSentinelWarningLines', () => {
  it('returns empty array when no soft-deletable models', () => {
    const models = [
      createMockModel({
        name: 'AuditLog',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'action', type: 'String' }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = buildSentinelWarningLines(schema, false);

    expect(result).toEqual([]);
  });

  it('includes sentinel strategy header', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = buildSentinelWarningLines(schema, false);

    expect(result.some((line) => line.includes("uniqueStrategy is 'sentinel'"))).toBe(true);
    expect(result.some((line) => line.includes('9999-12-31'))).toBe(true);
  });

  it('warns about standalone unique constraints', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = buildSentinelWarningLines(schema, false);

    expect(result.some((line) => line.includes('Standalone unique constraints detected'))).toBe(true);
    expect(result.some((line) => line.includes('User: email'))).toBe(true);
  });

  it('shows correctly configured compound uniques', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String' }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
        uniqueFields: [['email', 'deleted_at']],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = buildSentinelWarningLines(schema, false);

    expect(result.some((line) => line.includes('correctly configured'))).toBe(true);
    expect(result.some((line) => line.includes('@@unique([email, deleted_at])'))).toBe(true);
  });

  it('mentions schema requirements', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const result = buildSentinelWarningLines(schema, false);

    expect(result.some((line) => line.includes('non-nullable DateTime'))).toBe(true);
    expect(result.some((line) => line.includes('@@unique([field, deleted_at])'))).toBe(true);
  });
});

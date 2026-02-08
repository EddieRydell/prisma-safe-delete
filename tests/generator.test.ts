import { describe, it, expect } from 'vitest';
import {
  collectModelsWithUniqueFields,
  buildUniqueStrategyWarningLines,
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

  it('collects models with unique string fields', () => {
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
      fields: ['email'],
      deletedAtField: 'deleted_at',
    });
  });

  it('collects multiple unique fields from same model', () => {
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
    expect(result[0]!.fields).toContain('email');
    expect(result[0]!.fields).toContain('username');
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
    // allUniqueFields should include ALL unique fields, not just strings
    expect(result[0]!.fields).toContain('email');
    expect(result[0]!.fields).toContain('employeeNumber'); // Int field
    expect(result[0]!.fields).toContain('externalId'); // UUID field
  });
});

describe('buildUniqueStrategyWarningLines', () => {
  it('returns empty array when no models provided', () => {
    const result = buildUniqueStrategyWarningLines([]);
    expect(result).toEqual([]);
  });

  it('includes warning header', () => {
    const models: UniqueFieldInfo[] = [
      { model: 'User', fields: ['email'], deletedAtField: 'deleted_at' },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(result.some((line) => line.includes("uniqueStrategy is 'none'"))).toBe(true);
    expect(result.some((line) => line.includes('partial unique indexes'))).toBe(true);
  });

  it('lists all models and fields', () => {
    const models: UniqueFieldInfo[] = [
      { model: 'User', fields: ['email'], deletedAtField: 'deleted_at' },
      { model: 'Customer', fields: ['email', 'username'], deletedAtField: 'deleted_at' },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(result.some((line) => line.includes('User: email'))).toBe(true);
    expect(result.some((line) => line.includes('Customer: email, username'))).toBe(true);
  });

  it('generates correct SQL examples', () => {
    const models: UniqueFieldInfo[] = [
      { model: 'User', fields: ['email'], deletedAtField: 'deleted_at' },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) =>
        line.includes('CREATE UNIQUE INDEX user_email_active ON "User"(email) WHERE deleted_at IS NULL')
      )
    ).toBe(true);
  });

  it('generates SQL for multiple fields', () => {
    const models: UniqueFieldInfo[] = [
      { model: 'Customer', fields: ['email', 'username'], deletedAtField: 'deleted_at' },
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
      { model: 'Article', fields: ['slug'], deletedAtField: 'deletedAt' },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) => line.includes('WHERE deletedAt IS NULL'))
    ).toBe(true);
  });

  it('includes footer warning about consequences', () => {
    const models: UniqueFieldInfo[] = [
      { model: 'User', fields: ['email'], deletedAtField: 'deleted_at' },
    ];

    const result = buildUniqueStrategyWarningLines(models, false);

    expect(
      result.some((line) => line.includes('soft-deleted records will block new records'))
    ).toBe(true);
  });
});

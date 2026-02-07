import { describe, it, expect } from 'vitest';
import type { DMMF } from '@prisma/generator-helper';
import { parseDMMF } from '../src/dmmf-parser.js';
import {
  buildCascadeGraph,
  getCascadeOrder,
  getDirectChildren,
  hasCascadeChildren,
  getSoftDeletableDescendants,
} from '../src/cascade-graph.js';

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

describe('buildCascadeGraph', () => {
  it('builds graph for User -> Post cascade relationship', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
      createMockModel({
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
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);

    expect(graph['User']).toHaveLength(1);
    const child = graph['User']?.[0];
    expect(child?.model).toBe('Post');
    expect(child?.foreignKey).toEqual(['authorId']);
    expect(child?.parentKey).toEqual(['id']);
    expect(child?.isSoftDeletable).toBe(true);
    expect(child?.deletedAtField).toBe('deleted_at');
  });

  it('ignores non-cascade relations', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'comments',
            type: 'Comment',
            kind: 'object',
            isList: true,
            relationName: 'UserComments',
          }),
        ],
      }),
      createMockModel({
        name: 'Comment',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'authorId', type: 'String' }),
          createMockField({
            name: 'author',
            type: 'User',
            kind: 'object',
            relationName: 'UserComments',
            relationFromFields: ['authorId'],
            relationToFields: ['id'],
            relationOnDelete: 'SetNull',
          }),
        ],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);

    expect(graph['User']).toHaveLength(0);
  });

  it('builds multi-level cascade graph', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
      createMockModel({
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
          createMockField({
            name: 'comments',
            type: 'Comment',
            kind: 'object',
            isList: true,
            relationName: 'PostComments',
          }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
      createMockModel({
        name: 'Comment',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'postId', type: 'String' }),
          createMockField({
            name: 'post',
            type: 'Post',
            kind: 'object',
            relationName: 'PostComments',
            relationFromFields: ['postId'],
            relationToFields: ['id'],
            relationOnDelete: 'Cascade',
          }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);

    expect(graph['User']).toHaveLength(1);
    expect(graph['User']?.[0]?.model).toBe('Post');
    expect(graph['Post']).toHaveLength(1);
    expect(graph['Post']?.[0]?.model).toBe('Comment');
  });
});

describe('getCascadeOrder', () => {
  it('returns depth-first order for cascade', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
        ],
      }),
      createMockModel({
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
          createMockField({
            name: 'comments',
            type: 'Comment',
            kind: 'object',
            isList: true,
            relationName: 'PostComments',
          }),
        ],
      }),
      createMockModel({
        name: 'Comment',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'postId', type: 'String' }),
          createMockField({
            name: 'post',
            type: 'Post',
            kind: 'object',
            relationName: 'PostComments',
            relationFromFields: ['postId'],
            relationToFields: ['id'],
            relationOnDelete: 'Cascade',
          }),
        ],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);
    const order = getCascadeOrder(graph, 'User');

    // Depth-first: Comment should come before Post, Post before User
    expect(order).toEqual(['Comment', 'Post', 'User']);
  });

  it('handles models with no children', () => {
    const models = [
      createMockModel({
        name: 'Standalone',
        fields: [createMockField({ name: 'id', type: 'String', isId: true })],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);
    const order = getCascadeOrder(graph, 'Standalone');

    expect(order).toEqual(['Standalone']);
  });
});

describe('getDirectChildren', () => {
  it('returns direct children only', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
        ],
      }),
      createMockModel({
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
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);
    const children = getDirectChildren(graph, 'User');

    expect(children).toHaveLength(1);
    expect(children[0]?.model).toBe('Post');
  });

  it('returns empty array for unknown model', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [createMockField({ name: 'id', type: 'String', isId: true })],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);
    const children = getDirectChildren(graph, 'NonExistent');

    expect(children).toEqual([]);
  });
});

describe('hasCascadeChildren', () => {
  it('returns true when model has cascade children', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
        ],
      }),
      createMockModel({
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
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);

    expect(hasCascadeChildren(graph, 'User')).toBe(true);
    expect(hasCascadeChildren(graph, 'Post')).toBe(false);
  });
});

describe('getSoftDeletableDescendants', () => {
  it('returns only soft-deletable descendants', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
      createMockModel({
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
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
          createMockField({
            name: 'logs',
            type: 'PostLog',
            kind: 'object',
            isList: true,
            relationName: 'PostLogs',
          }),
        ],
      }),
      createMockModel({
        name: 'PostLog',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'postId', type: 'String' }),
          createMockField({
            name: 'post',
            type: 'Post',
            kind: 'object',
            relationName: 'PostLogs',
            relationFromFields: ['postId'],
            relationToFields: ['id'],
            relationOnDelete: 'Cascade',
          }),
          // No deleted_at field - not soft-deletable
        ],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);
    const descendants = getSoftDeletableDescendants(graph, schema, 'User');

    expect(descendants).toHaveLength(1);
    expect(descendants[0]?.name).toBe('Post');
  });
});

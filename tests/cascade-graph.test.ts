import { describe, it, expect } from 'vitest';
import { parseDMMF } from '../src/dmmf-parser.js';
import {
  buildCascadeGraph,
  getCascadeOrder,
  getDirectChildren,
  hasCascadeChildren,
  getSoftDeletableDescendants,
} from '../src/cascade-graph.js';
import { createMockField, createMockModel, createMockDMMF } from './helpers/mock-dmmf.js';

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

  it('uses relation references instead of parent PK when FK targets a non-PK unique field', () => {
    const models = [
      createMockModel({
        name: 'Tenant',
        fields: [
          createMockField({ name: 'id', type: 'Int', isId: true }),
          createMockField({ name: 'slug', type: 'String', isUnique: true }),
          createMockField({
            name: 'projects',
            type: 'Project',
            kind: 'object',
            isList: true,
            relationName: 'TenantProjects',
          }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: false,
          }),
        ],
      }),
      createMockModel({
        name: 'Project',
        fields: [
          createMockField({ name: 'id', type: 'Int', isId: true }),
          createMockField({ name: 'tenantSlug', type: 'String' }),
          createMockField({
            name: 'tenant',
            type: 'Tenant',
            kind: 'object',
            relationName: 'TenantProjects',
            relationFromFields: ['tenantSlug'],
            relationToFields: ['slug'],
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

    expect(graph['Tenant']).toHaveLength(1);
    const child = graph['Tenant']?.[0];
    expect(child?.model).toBe('Project');
    expect(child?.foreignKey).toEqual(['tenantSlug']);
    // parentKey should be 'slug' (the referenced unique field), NOT 'id' (the PK)
    expect(child?.parentKey).toEqual(['slug']);
    expect(child?.isSoftDeletable).toBe(true);
  });

  it('falls back to parent PK when relation references are empty', () => {
    // Simulate a relation field where DMMF provides empty relationToFields
    // (this happens on the "list" side of a relation, but we filter those out;
    // this tests the fallback path if references is empty on a non-list relation)
    const models = [
      createMockModel({
        name: 'Owner',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({
            name: 'items',
            type: 'Item',
            kind: 'object',
            isList: true,
            relationName: 'OwnerItems',
          }),
        ],
      }),
      createMockModel({
        name: 'Item',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'ownerId', type: 'String' }),
          createMockField({
            name: 'owner',
            type: 'Owner',
            kind: 'object',
            relationName: 'OwnerItems',
            relationFromFields: ['ownerId'],
            relationToFields: [],
            relationOnDelete: 'Cascade',
          }),
        ],
      }),
    ];

    const dmmf = createMockDMMF(models);
    const schema = parseDMMF(dmmf);
    const graph = buildCascadeGraph(schema);

    expect(graph['Owner']).toHaveLength(1);
    const child = graph['Owner']?.[0];
    expect(child?.foreignKey).toEqual(['ownerId']);
    // Should fall back to parent's primary key
    expect(child?.parentKey).toEqual(['id']);
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

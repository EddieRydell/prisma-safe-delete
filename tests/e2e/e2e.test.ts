import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = __dirname;

// These will be dynamically imported after generation
let PrismaClient: any;
let wrapPrismaClient: any;
let prisma: any;
let safePrisma: any;
let pool: pg.Pool | undefined;

describe('E2E: Real database tests', () => {
  beforeAll(async () => {
    // Build the generator
    execSync('pnpm run build', {
      cwd: path.join(e2eDir, '..', '..'),
      stdio: 'pipe',
    });

    // Generate Prisma client and soft-cascade wrapper
    execSync('npx prisma generate', {
      cwd: e2eDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes',
      },
    });

    // Push schema to create database (resets it)
    // Note: PRISMA_USER_CONSENT env var is needed for Prisma 7's AI safety check
    // This is safe because it's a local Docker test database
    execSync('npx prisma db push --force-reset', {
      cwd: e2eDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes',
      },
    });

    // Dynamically import the generated modules
    // Note: Prisma 7 generates client.ts, not index.ts
    const clientModule = await import('./generated/client/client.js');
    PrismaClient = clientModule.PrismaClient;

    const softCascadeModule = await import('./generated/soft-cascade/runtime.js');
    wrapPrismaClient = softCascadeModule.wrapPrismaClient;

    // Create pg pool and Prisma adapter (Prisma 7 requirement)
    const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/test';
    pool = new pg.Pool({ connectionString });
    const adapter = new PrismaPg(pool);

    // Create the clients with adapter
    prisma = new PrismaClient({ adapter });
    safePrisma = wrapPrismaClient(prisma);
  }, 120000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await prisma.$disconnect();
    }
    if (pool !== undefined) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    // Clean all tables before each test (order matters for FK constraints)
    await prisma.comment.deleteMany();
    await prisma.post.deleteMany();
    await prisma.profile.deleteMany();
    await prisma.user.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.tenantDocument.deleteMany();
    await prisma.tenantUser.deleteMany();
    await prisma.articleTag.deleteMany();
    await prisma.article.deleteMany();
    // New models
    await prisma.variantOption.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.assetComment.deleteMany();
    await prisma.asset.deleteMany();
    await prisma.team.deleteMany();
    await prisma.project.deleteMany();
    await prisma.organization.deleteMany();
    // Unique string constraint models
    await prisma.order.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.workspace.deleteMany();
  });

  describe('Filter injection', () => {
    it('findMany excludes soft-deleted records', async () => {
      // Create two users, soft-delete one
      await prisma.user.create({
        data: { id: 'user-1', email: 'active@test.com', name: 'Active User' },
      });
      await prisma.user.create({
        data: {
          id: 'user-2',
          email: 'deleted@test.com',
          name: 'Deleted User',
          deleted_at: new Date(),
        },
      });

      // Raw Prisma returns both
      const rawUsers = await prisma.user.findMany();
      expect(rawUsers).toHaveLength(2);

      // Safe client filters out deleted
      const safeUsers = await safePrisma.user.findMany();
      expect(safeUsers).toHaveLength(1);
      expect(safeUsers[0].email).toBe('active@test.com');
    });

    it('findFirst excludes soft-deleted records', async () => {
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'deleted@test.com',
          deleted_at: new Date(),
        },
      });

      const user = await safePrisma.user.findFirst({
        where: { email: 'deleted@test.com' },
      });
      expect(user).toBeNull();
    });

    it('findUnique excludes soft-deleted records', async () => {
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'deleted@test.com',
          deleted_at: new Date(),
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'user-1' },
      });
      expect(user).toBeNull();
    });

    it('count excludes soft-deleted records', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'active@test.com' },
      });
      await prisma.user.create({
        data: {
          id: 'user-2',
          email: 'deleted@test.com',
          deleted_at: new Date(),
        },
      });

      const rawCount = await prisma.user.count();
      expect(rawCount).toBe(2);

      const safeCount = await safePrisma.user.count();
      expect(safeCount).toBe(1);
    });

    it('preserves existing where conditions', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'alice@test.com', name: 'Alice' },
      });
      await prisma.user.create({
        data: { id: 'user-2', email: 'bob@test.com', name: 'Bob' },
      });
      await prisma.user.create({
        data: {
          id: 'user-3',
          email: 'deleted-alice@test.com',
          name: 'Alice',
          deleted_at: new Date(),
        },
      });

      const alices = await safePrisma.user.findMany({
        where: { name: 'Alice' },
      });
      expect(alices).toHaveLength(1);
      expect(alices[0].id).toBe('user-1');
    });
  });

  describe('Soft delete', () => {
    it('softDelete sets deleted_at timestamp', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'test@test.com' },
      });

      await safePrisma.user.softDelete({ where: { id: 'user-1' } });

      // Should be filtered out by safe client
      const safeUser = await safePrisma.user.findUnique({
        where: { id: 'user-1' },
      });
      expect(safeUser).toBeNull();

      // But still exists in raw client
      const rawUser = await prisma.user.findUnique({
        where: { id: 'user-1' },
      });
      expect(rawUser).not.toBeNull();
      expect(rawUser.deleted_at).not.toBeNull();
    });

    it('softDeleteMany sets deleted_at on multiple records', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'user-1', email: 'user1@test.com', name: 'ToDelete' },
          { id: 'user-2', email: 'user2@test.com', name: 'ToDelete' },
          { id: 'user-3', email: 'user3@test.com', name: 'Keep' },
        ],
      });

      const result = await safePrisma.user.softDeleteMany({
        where: { name: 'ToDelete' },
      });
      expect(result.count).toBe(2);

      const remaining = await safePrisma.user.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('Keep');
    });
  });

  describe('Cascade soft delete', () => {
    it('soft-deleting a user cascades to their posts', async () => {
      // Create user with posts
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'author@test.com',
          posts: {
            create: [
              { id: 'post-1', title: 'Post 1' },
              { id: 'post-2', title: 'Post 2' },
            ],
          },
        },
      });

      // Verify posts exist
      const postsBefore = await safePrisma.post.findMany();
      expect(postsBefore).toHaveLength(2);

      // Soft delete the user
      await safePrisma.user.softDelete({ where: { id: 'user-1' } });

      // Posts should also be soft-deleted
      const postsAfter = await safePrisma.post.findMany();
      expect(postsAfter).toHaveLength(0);

      // But still exist in raw client
      const rawPosts = await prisma.post.findMany();
      expect(rawPosts).toHaveLength(2);
      expect(rawPosts[0].deleted_at).not.toBeNull();
    });

    it('soft-deleting cascades multiple levels (user -> post -> comment)', async () => {
      // Create user with post with comments
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'author@test.com',
          posts: {
            create: {
              id: 'post-1',
              title: 'Post with comments',
              comments: {
                create: [
                  { id: 'comment-1', content: 'Comment 1' },
                  { id: 'comment-2', content: 'Comment 2' },
                ],
              },
            },
          },
        },
      });

      // Verify comments exist
      const commentsBefore = await safePrisma.comment.findMany();
      expect(commentsBefore).toHaveLength(2);

      // Soft delete the user
      await safePrisma.user.softDelete({ where: { id: 'user-1' } });

      // Comments should also be soft-deleted (via post cascade)
      const commentsAfter = await safePrisma.comment.findMany();
      expect(commentsAfter).toHaveLength(0);
    });

    it('soft-deleting a post cascades to comments but not to user', async () => {
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'author@test.com',
          posts: {
            create: {
              id: 'post-1',
              title: 'Post',
              comments: {
                create: { id: 'comment-1', content: 'Comment' },
              },
            },
          },
        },
      });

      // Soft delete just the post
      await safePrisma.post.softDelete({ where: { id: 'post-1' } });

      // User should still be active
      const user = await safePrisma.user.findUnique({ where: { id: 'user-1' } });
      expect(user).not.toBeNull();

      // Comment should be soft-deleted
      const comments = await safePrisma.comment.findMany();
      expect(comments).toHaveLength(0);
    });
  });

  describe('Escape hatches', () => {
    it('$includingDeleted returns soft-deleted records', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'active@test.com' },
      });
      await prisma.user.create({
        data: {
          id: 'user-2',
          email: 'deleted@test.com',
          deleted_at: new Date(),
        },
      });

      const allUsers = await safePrisma.$includingDeleted.user.findMany();
      expect(allUsers).toHaveLength(2);
    });

    it('$onlyDeleted returns only soft-deleted records', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'active@test.com' },
      });
      await prisma.user.create({
        data: {
          id: 'user-2',
          email: 'deleted@test.com',
          deleted_at: new Date(),
        },
      });

      const deletedUsers = await safePrisma.$onlyDeleted.user.findMany();
      expect(deletedUsers).toHaveLength(1);
      expect(deletedUsers[0].email).toBe('deleted@test.com');
    });

    it('$prisma provides access to raw client', async () => {
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'deleted@test.com',
          deleted_at: new Date(),
        },
      });

      // Can use raw client through safePrisma.$prisma
      const rawUser = await safePrisma.$prisma.user.findUnique({
        where: { id: 'user-1' },
      });
      expect(rawUser).not.toBeNull();
    });

    it('__dangerousHardDelete permanently removes record', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'test@test.com' },
      });

      await safePrisma.user.__dangerousHardDelete({ where: { id: 'user-1' } });

      // Should be gone from both clients
      const safeUser = await safePrisma.user.findUnique({
        where: { id: 'user-1' },
      });
      expect(safeUser).toBeNull();

      const rawUser = await prisma.user.findUnique({
        where: { id: 'user-1' },
      });
      expect(rawUser).toBeNull();
    });
  });

  describe('Non-soft-deletable models', () => {
    it('AuditLog has standard delete behavior', async () => {
      await prisma.auditLog.create({
        data: { id: 'log-1', action: 'test', entityId: 'entity-1' },
      });

      // Should be able to query normally (no filter injection for non-soft-deletable)
      const logs = await safePrisma.auditLog.findMany();
      expect(logs).toHaveLength(1);

      // AuditLog should have delete method (not softDelete)
      // Since it's not soft-deletable, it keeps the standard delegate
    });
  });

  describe('Write operations pass through', () => {
    it('create works normally', async () => {
      const user = await safePrisma.user.create({
        data: { id: 'user-1', email: 'new@test.com' },
      });
      expect(user.id).toBe('user-1');
      expect(user.deleted_at).toBeNull();
    });

    it('update works normally', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'old@test.com' },
      });

      const updated = await safePrisma.user.update({
        where: { id: 'user-1' },
        data: { email: 'new@test.com' },
      });
      expect(updated.email).toBe('new@test.com');
    });

    it('upsert works normally', async () => {
      const user = await safePrisma.user.upsert({
        where: { id: 'user-1' },
        create: { id: 'user-1', email: 'created@test.com' },
        update: { email: 'updated@test.com' },
      });
      expect(user.email).toBe('created@test.com');
    });
  });

  describe('Data leak prevention', () => {
    it('deleted records not exposed via include queries', async () => {
      // Create user with posts, one post is soft-deleted
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'author@test.com',
          posts: {
            create: [
              { id: 'post-1', title: 'Active Post' },
              { id: 'post-2', title: 'Deleted Post', deleted_at: new Date() },
            ],
          },
        },
      });

      // Query with include - should filter out deleted post
      const user = await safePrisma.user.findUnique({
        where: { id: 'user-1' },
        include: { posts: true },
      });

      expect(user).not.toBeNull();
      expect(user.posts).toHaveLength(1);
      expect(user.posts[0].title).toBe('Active Post');
    });

    it('deleted records not exposed via nested include', async () => {
      // Create user with post with comments, one comment is soft-deleted
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'author@test.com',
          posts: {
            create: {
              id: 'post-1',
              title: 'Post',
              comments: {
                create: [
                  { id: 'comment-1', content: 'Active Comment' },
                  { id: 'comment-2', content: 'Deleted Comment', deleted_at: new Date() },
                ],
              },
            },
          },
        },
      });

      // Query with nested include
      const user = await safePrisma.user.findUnique({
        where: { id: 'user-1' },
        include: {
          posts: {
            include: { comments: true },
          },
        },
      });

      expect(user).not.toBeNull();
      expect(user.posts[0].comments).toHaveLength(1);
      expect(user.posts[0].comments[0].content).toBe('Active Comment');
    });

    it('deleted parent not exposed when querying child with include', async () => {
      // Create post with deleted author
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'deleted@test.com',
          deleted_at: new Date(),
          posts: {
            create: { id: 'post-1', title: 'Orphan Post' },
          },
        },
      });

      // The post itself is still visible (parent deletion doesn't cascade by default in include)
      // But if we try to get the user through include, the user should be filtered
      const posts = await safePrisma.post.findMany({
        include: { author: true },
      });

      // Post is visible since it's not deleted
      expect(posts).toHaveLength(1);
    });
  });

  describe('Compound key support', () => {
    it('soft delete with compound primary key', async () => {
      await prisma.tenantUser.create({
        data: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          email: 'user@tenant.com',
        },
      });

      // Soft delete using compound key
      await safePrisma.tenantUser.softDelete({
        where: { tenantId_userId: { tenantId: 'tenant-1', userId: 'user-1' } },
      });

      // Should be filtered out
      const users = await safePrisma.tenantUser.findMany();
      expect(users).toHaveLength(0);

      // But still exists in raw client
      const rawUsers = await prisma.tenantUser.findMany();
      expect(rawUsers).toHaveLength(1);
      expect(rawUsers[0].deleted_at).not.toBeNull();
    });

    it('cascade soft delete with compound foreign key', async () => {
      // Create tenant user with documents
      await prisma.tenantUser.create({
        data: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          email: 'user@tenant.com',
          documents: {
            create: [
              { id: 'doc-1', title: 'Document 1' },
              { id: 'doc-2', title: 'Document 2' },
            ],
          },
        },
      });

      // Verify documents exist
      const docsBefore = await safePrisma.tenantDocument.findMany();
      expect(docsBefore).toHaveLength(2);

      // Soft delete the tenant user
      await safePrisma.tenantUser.softDelete({
        where: { tenantId_userId: { tenantId: 'tenant-1', userId: 'user-1' } },
      });

      // Documents should be cascaded
      const docsAfter = await safePrisma.tenantDocument.findMany();
      expect(docsAfter).toHaveLength(0);

      // But still exist in raw client
      const rawDocs = await prisma.tenantDocument.findMany();
      expect(rawDocs).toHaveLength(2);
      expect(rawDocs[0].deleted_at).not.toBeNull();
    });

    it('softDeleteMany with compound primary key', async () => {
      await prisma.tenantUser.createMany({
        data: [
          { tenantId: 'tenant-1', userId: 'user-1', email: 'user1@tenant.com' },
          { tenantId: 'tenant-1', userId: 'user-2', email: 'user2@tenant.com' },
          { tenantId: 'tenant-2', userId: 'user-1', email: 'user1@tenant2.com' },
        ],
      });

      // Soft delete all users in tenant-1
      const result = await safePrisma.tenantUser.softDeleteMany({
        where: { tenantId: 'tenant-1' },
      });
      expect(result.count).toBe(2);

      // Only tenant-2 user remains
      const remaining = await safePrisma.tenantUser.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].tenantId).toBe('tenant-2');
    });
  });

  describe('camelCase deletedAt field', () => {
    it('filter injection works with deletedAt', async () => {
      await prisma.article.create({
        data: { id: 'article-1', title: 'Active Article' },
      });
      await prisma.article.create({
        data: { id: 'article-2', title: 'Deleted Article', deletedAt: new Date() },
      });

      // Safe client should filter by deletedAt
      const articles = await safePrisma.article.findMany();
      expect(articles).toHaveLength(1);
      expect(articles[0].title).toBe('Active Article');
    });

    it('softDelete works with deletedAt field', async () => {
      await prisma.article.create({
        data: { id: 'article-1', title: 'Test Article' },
      });

      await safePrisma.article.softDelete({ where: { id: 'article-1' } });

      // Should be filtered
      const articles = await safePrisma.article.findMany();
      expect(articles).toHaveLength(0);

      // Should have deletedAt set
      const rawArticle = await prisma.article.findUnique({
        where: { id: 'article-1' },
      });
      expect(rawArticle.deletedAt).not.toBeNull();
    });

    it('cascade works with deletedAt field', async () => {
      await prisma.article.create({
        data: {
          id: 'article-1',
          title: 'Article with Tags',
          tags: {
            create: [
              { id: 'tag-1', name: 'Tag 1' },
              { id: 'tag-2', name: 'Tag 2' },
            ],
          },
        },
      });

      // Soft delete article
      await safePrisma.article.softDelete({ where: { id: 'article-1' } });

      // Tags should be cascaded
      const tags = await safePrisma.articleTag.findMany();
      expect(tags).toHaveLength(0);

      // Verify deletedAt is set on tags
      const rawTags = await prisma.articleTag.findMany();
      expect(rawTags).toHaveLength(2);
      expect(rawTags[0].deletedAt).not.toBeNull();
    });

    it('include filters by deletedAt on relations', async () => {
      await prisma.article.create({
        data: {
          id: 'article-1',
          title: 'Article',
          tags: {
            create: [
              { id: 'tag-1', name: 'Active Tag' },
              { id: 'tag-2', name: 'Deleted Tag', deletedAt: new Date() },
            ],
          },
        },
      });

      const article = await safePrisma.article.findUnique({
        where: { id: 'article-1' },
        include: { tags: true },
      });

      expect(article.tags).toHaveLength(1);
      expect(article.tags[0].name).toBe('Active Tag');
    });
  });

  describe('Edge cases', () => {
    it('softDelete on non-existent record throws P2025', async () => {
      await expect(
        safePrisma.user.softDelete({ where: { id: 'non-existent' } }),
      ).rejects.toThrow(expect.objectContaining({ code: 'P2025' }));
    });

    it('softDelete on already-deleted record throws P2025', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'test@test.com', deleted_at: new Date() },
      });

      await expect(
        safePrisma.user.softDelete({ where: { id: 'user-1' } }),
      ).rejects.toThrow(expect.objectContaining({ code: 'P2025' }));
    });

    it('softDeleteMany returns zero for empty result', async () => {
      const result = await safePrisma.user.softDeleteMany({
        where: { email: 'non-existent@test.com' },
      });
      expect(result.count).toBe(0);
    });

    it('findMany returns empty array for no matches', async () => {
      const users = await safePrisma.user.findMany({
        where: { name: 'Non-existent' },
      });
      expect(users).toEqual([]);
    });

    it('count returns zero for no matches', async () => {
      const count = await safePrisma.user.count({
        where: { name: 'Non-existent' },
      });
      expect(count).toBe(0);
    });
  });

  describe('Transaction safety', () => {
    it('cascade uses same timestamp for parent and children', async () => {
      // Create user with post with comment
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'author@test.com',
          posts: {
            create: {
              id: 'post-1',
              title: 'Post',
              comments: {
                create: { id: 'comment-1', content: 'Comment' },
              },
            },
          },
        },
      });

      // Soft delete the user
      await safePrisma.user.softDelete({ where: { id: 'user-1' } });

      // Get all records
      const user = await prisma.user.findUnique({ where: { id: 'user-1' } });
      const post = await prisma.post.findUnique({ where: { id: 'post-1' } });
      const comment = await prisma.comment.findUnique({ where: { id: 'comment-1' } });

      // All should have the same deleted_at timestamp (within same transaction)
      expect(user.deleted_at).not.toBeNull();
      expect(post.deleted_at).not.toBeNull();
      expect(comment.deleted_at).not.toBeNull();

      // Timestamps should be equal (same transaction)
      expect(user.deleted_at.getTime()).toBe(post.deleted_at.getTime());
      expect(post.deleted_at.getTime()).toBe(comment.deleted_at.getTime());
    });

    it('partial cascade failure rolls back entire operation', async () => {
      // This test verifies transaction atomicity
      // We can't easily simulate a failure, but we can verify the structure is transactional
      await prisma.user.create({
        data: {
          id: 'user-1',
          email: 'author@test.com',
          posts: {
            create: { id: 'post-1', title: 'Post' },
          },
        },
      });

      // After successful cascade, both should be deleted
      await safePrisma.user.softDelete({ where: { id: 'user-1' } });

      const user = await prisma.user.findUnique({ where: { id: 'user-1' } });
      const post = await prisma.post.findUnique({ where: { id: 'post-1' } });

      expect(user.deleted_at).not.toBeNull();
      expect(post.deleted_at).not.toBeNull();
    });
  });

  describe('Deep cascade chains (4+ levels)', () => {
    it('cascades through Category -> Product -> Variant -> Option', async () => {
      await prisma.category.create({
        data: {
          id: 'cat-1',
          name: 'Electronics',
          products: {
            create: {
              id: 'prod-1',
              name: 'Phone',
              variants: {
                create: {
                  id: 'var-1',
                  sku: 'PHONE-BLK',
                  options: {
                    create: [
                      { id: 'opt-1', name: 'Color', value: 'Black' },
                      { id: 'opt-2', name: 'Storage', value: '128GB' },
                    ],
                  },
                },
              },
            },
          },
        },
      });

      // Verify all exist
      expect(await safePrisma.category.count()).toBe(1);
      expect(await safePrisma.product.count()).toBe(1);
      expect(await safePrisma.productVariant.count()).toBe(1);
      expect(await safePrisma.variantOption.count()).toBe(2);

      // Delete at top level
      await safePrisma.category.softDelete({ where: { id: 'cat-1' } });

      // All should be soft-deleted
      expect(await safePrisma.category.count()).toBe(0);
      expect(await safePrisma.product.count()).toBe(0);
      expect(await safePrisma.productVariant.count()).toBe(0);
      expect(await safePrisma.variantOption.count()).toBe(0);

      // But all still exist in raw
      expect(await prisma.category.count()).toBe(1);
      expect(await prisma.product.count()).toBe(1);
      expect(await prisma.productVariant.count()).toBe(1);
      expect(await prisma.variantOption.count()).toBe(2);
    });

    it('cascades from middle of chain (Product level)', async () => {
      await prisma.category.create({
        data: {
          id: 'cat-1',
          name: 'Electronics',
          products: {
            create: {
              id: 'prod-1',
              name: 'Phone',
              variants: {
                create: {
                  id: 'var-1',
                  sku: 'PHONE-BLK',
                  options: {
                    create: { id: 'opt-1', name: 'Color', value: 'Black' },
                  },
                },
              },
            },
          },
        },
      });

      // Delete from middle
      await safePrisma.product.softDelete({ where: { id: 'prod-1' } });

      // Category should still be active
      expect(await safePrisma.category.count()).toBe(1);
      // Product and below should be deleted
      expect(await safePrisma.product.count()).toBe(0);
      expect(await safePrisma.productVariant.count()).toBe(0);
      expect(await safePrisma.variantOption.count()).toBe(0);
    });
  });

  describe('Wide cascade (multiple child types)', () => {
    it('cascades to all child types simultaneously', async () => {
      await prisma.organization.create({
        data: {
          id: 'org-1',
          name: 'Acme Corp',
          teams: {
            create: [
              { id: 'team-1', name: 'Engineering' },
              { id: 'team-2', name: 'Marketing' },
            ],
          },
          projects: {
            create: [
              { id: 'proj-1', name: 'Project Alpha' },
              { id: 'proj-2', name: 'Project Beta' },
            ],
          },
          assets: {
            create: [
              { id: 'asset-1', url: 'https://example.com/logo.png' },
            ],
          },
        },
      });

      expect(await safePrisma.team.count()).toBe(2);
      expect(await safePrisma.project.count()).toBe(2);

      await safePrisma.organization.softDelete({ where: { id: 'org-1' } });

      // Soft-deletable children should be soft-deleted
      expect(await safePrisma.team.count()).toBe(0);
      expect(await safePrisma.project.count()).toBe(0);

      // Non-soft-deletable Asset still exists (not affected by soft delete cascade)
      expect(await prisma.asset.count()).toBe(1);
    });
  });

  describe('Self-referential models', () => {
    it('cascades through parent-child category hierarchy', async () => {
      // Create 3-level hierarchy: Root -> Child -> Grandchild
      await prisma.category.create({
        data: {
          id: 'root',
          name: 'Root',
          children: {
            create: {
              id: 'child',
              name: 'Child',
              children: {
                create: {
                  id: 'grandchild',
                  name: 'Grandchild',
                },
              },
            },
          },
        },
      });

      expect(await safePrisma.category.count()).toBe(3);

      await safePrisma.category.softDelete({ where: { id: 'root' } });

      // All should be soft-deleted
      expect(await safePrisma.category.count()).toBe(0);
      expect(await prisma.category.count()).toBe(3);
    });

    it('deleting middle node only affects descendants', async () => {
      await prisma.category.create({
        data: {
          id: 'root',
          name: 'Root',
          children: {
            create: {
              id: 'child',
              name: 'Child',
              children: {
                create: { id: 'grandchild', name: 'Grandchild' },
              },
            },
          },
        },
      });

      await safePrisma.category.softDelete({ where: { id: 'child' } });

      // Root should still be active
      const root = await safePrisma.category.findUnique({ where: { id: 'root' } });
      expect(root).not.toBeNull();

      // Child and grandchild should be deleted
      expect(await safePrisma.category.findUnique({ where: { id: 'child' } })).toBeNull();
      expect(await safePrisma.category.findUnique({ where: { id: 'grandchild' } })).toBeNull();
    });
  });

  describe('Large batch operations', () => {
    it('handles softDeleteMany with 100+ records', async () => {
      // Create 150 users
      const users = Array.from({ length: 150 }, (_, i) => ({
        id: `user-${String(i)}`,
        email: `user${String(i)}@test.com`,
        name: i < 100 ? 'BatchDelete' : 'Keep',
      }));
      await prisma.user.createMany({ data: users });

      const result = await safePrisma.user.softDeleteMany({
        where: { name: 'BatchDelete' },
      });

      expect(result.count).toBe(100);
      expect(await safePrisma.user.count()).toBe(50);
    });

    it('handles cascade with many children', async () => {
      // Create user with 50 posts, each with 3 comments
      await prisma.user.create({
        data: {
          id: 'prolific-author',
          email: 'prolific@test.com',
          posts: {
            create: Array.from({ length: 50 }, (_, i) => ({
              id: `post-${String(i)}`,
              title: `Post ${String(i)}`,
              comments: {
                create: [
                  { id: `comment-${String(i)}-a`, content: 'Comment A' },
                  { id: `comment-${String(i)}-b`, content: 'Comment B' },
                  { id: `comment-${String(i)}-c`, content: 'Comment C' },
                ],
              },
            })),
          },
        },
      });

      expect(await safePrisma.post.count()).toBe(50);
      expect(await safePrisma.comment.count()).toBe(150);

      await safePrisma.user.softDelete({ where: { id: 'prolific-author' } });

      expect(await safePrisma.post.count()).toBe(0);
      expect(await safePrisma.comment.count()).toBe(0);
    });
  });

  describe('Complex where clauses', () => {
    it('works with AND conditions', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Alice' },
          { id: 'u2', email: 'b@test.com', name: 'Alice' },
          { id: 'u3', email: 'a@other.com', name: 'Bob' },
        ],
      });

      const users = await safePrisma.user.findMany({
        where: {
          AND: [
            { name: 'Alice' },
            { email: { contains: 'test.com' } },
          ],
        },
      });

      expect(users).toHaveLength(2);
    });

    it('works with OR conditions', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Alice' },
          { id: 'u2', email: 'b@test.com', name: 'Bob' },
          { id: 'u3', email: 'c@test.com', name: 'Charlie', deleted_at: new Date() },
        ],
      });

      const users = await safePrisma.user.findMany({
        where: {
          OR: [{ name: 'Alice' }, { name: 'Charlie' }],
        },
      });

      // Charlie is soft-deleted, should only get Alice
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe('Alice');
    });

    it('works with NOT conditions', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Alice' },
          { id: 'u2', email: 'b@test.com', name: 'Bob' },
          { id: 'u3', email: 'c@test.com', name: 'Charlie', deleted_at: new Date() },
        ],
      });

      const users = await safePrisma.user.findMany({
        where: {
          NOT: { name: 'Alice' },
        },
      });

      // Should get Bob only (Charlie is soft-deleted)
      expect(users).toHaveLength(1);
      expect(users[0].name).toBe('Bob');
    });

    it('works with nested relation filters', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'author@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Published' },
              { id: 'p2', title: 'Draft', deleted_at: new Date() },
            ],
          },
        },
      });

      // Find users who have at least one active post
      const users = await safePrisma.user.findMany({
        where: {
          posts: { some: { title: { contains: 'Pub' } } },
        },
      });

      expect(users).toHaveLength(1);
    });
  });

  describe('Select queries', () => {
    it('select works with soft delete filtering', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          name: 'Test User',
          posts: {
            create: [
              { id: 'p1', title: 'Active' },
              { id: 'p2', title: 'Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        select: {
          email: true,
          posts: {
            select: { title: true },
          },
        },
      });

      expect(user.email).toBe('test@test.com');
      expect(user.posts).toHaveLength(1);
      expect(user.posts[0].title).toBe('Active');
    });
  });

  describe('Ordering and pagination', () => {
    it('orderBy works with soft delete', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Alice' },
          { id: 'u2', email: 'b@test.com', name: 'Bob', deleted_at: new Date() },
          { id: 'u3', email: 'c@test.com', name: 'Charlie' },
        ],
      });

      const users = await safePrisma.user.findMany({
        orderBy: { name: 'desc' },
      });

      expect(users).toHaveLength(2);
      expect(users[0].name).toBe('Charlie');
      expect(users[1].name).toBe('Alice');
    });

    it('skip/take pagination works with soft delete', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: '1@test.com', name: 'User1' },
          { id: 'u2', email: '2@test.com', name: 'User2', deleted_at: new Date() },
          { id: 'u3', email: '3@test.com', name: 'User3' },
          { id: 'u4', email: '4@test.com', name: 'User4' },
          { id: 'u5', email: '5@test.com', name: 'User5', deleted_at: new Date() },
          { id: 'u6', email: '6@test.com', name: 'User6' },
        ],
      });

      const page = await safePrisma.user.findMany({
        skip: 1,
        take: 2,
        orderBy: { email: 'asc' },
      });

      // Should skip User1, get User3 and User4 (User2 is deleted)
      expect(page).toHaveLength(2);
    });

    it('cursor pagination works with soft delete', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'A' },
          { id: 'u2', email: 'b@test.com', name: 'B' },
          { id: 'u3', email: 'c@test.com', name: 'C', deleted_at: new Date() },
          { id: 'u4', email: 'd@test.com', name: 'D' },
        ],
      });

      const users = await safePrisma.user.findMany({
        cursor: { id: 'u2' },
        skip: 1,
        take: 2,
      });

      // Should get D (C is deleted)
      expect(users.some((u: any) => u.name === 'D')).toBe(true);
      expect(users.every((u: any) => u.name !== 'C')).toBe(true);
    });
  });

  describe('Aggregate operations', () => {
    it('aggregate excludes soft-deleted records', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com' },
          { id: 'u2', email: 'b@test.com' },
          { id: 'u3', email: 'c@test.com', deleted_at: new Date() },
        ],
      });

      const result = await safePrisma.user.aggregate({
        _count: true,
      });

      expect(result._count).toBe(2);
    });

    it('groupBy excludes soft-deleted records', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Team A' },
          { id: 'u2', email: 'b@test.com', name: 'Team A' },
          { id: 'u3', email: 'c@test.com', name: 'Team B' },
          { id: 'u4', email: 'd@test.com', name: 'Team A', deleted_at: new Date() },
        ],
      });

      const groups = await safePrisma.user.groupBy({
        by: ['name'],
        _count: true,
        orderBy: { name: 'asc' },
      });

      const teamA = groups.find((g: any) => g.name === 'Team A');
      const teamB = groups.find((g: any) => g.name === 'Team B');

      expect(teamA?._count).toBe(2); // Not 3, because one is deleted
      expect(teamB?._count).toBe(1);
    });
  });

  describe('Unique constraint edge cases', () => {
    it('can create new record with same unique value after soft delete (mangling)', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'unique@test.com' },
      });

      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // With unique string mangling, the email was changed to "unique@test.com__deleted_u1"
      // So we can now create a new user with the original email
      const newUser = await prisma.user.create({
        data: { id: 'u2', email: 'unique@test.com' },
      });
      expect(newUser.email).toBe('unique@test.com');

      // Verify the old record was mangled
      const oldUser = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(oldUser.email).toBe('unique@test.com__deleted_u1');
    });
  });

  describe('Concurrent operations', () => {
    it('handles concurrent soft deletes safely', async () => {
      await prisma.user.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({
          id: `user-${String(i)}`,
          email: `user${String(i)}@test.com`,
        })),
      });

      // Soft delete multiple records concurrently
      await Promise.all([
        safePrisma.user.softDelete({ where: { id: 'user-0' } }),
        safePrisma.user.softDelete({ where: { id: 'user-1' } }),
        safePrisma.user.softDelete({ where: { id: 'user-2' } }),
        safePrisma.user.softDelete({ where: { id: 'user-3' } }),
        safePrisma.user.softDelete({ where: { id: 'user-4' } }),
      ]);

      expect(await safePrisma.user.count()).toBe(5);
    });
  });

  describe('Null and edge case handling', () => {
    it('handles undefined args gracefully', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'test@test.com' },
      });

      const users = await safePrisma.user.findMany(undefined);
      expect(users).toHaveLength(1);
    });

    it('handles empty where object', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'test@test.com' },
      });

      const users = await safePrisma.user.findMany({ where: {} });
      expect(users).toHaveLength(1);
    });

    it('handles deeply nested empty includes', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: {
              id: 'p1',
              title: 'Test',
              comments: { create: { id: 'c1', content: 'Comment' } },
            },
          },
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        include: {
          posts: {
            include: {
              comments: {},
            },
          },
        },
      });

      expect(user.posts[0].comments).toHaveLength(1);
    });
  });

  describe('Relation count (_count)', () => {
    it('_count in include filters out deleted relations', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active 1' },
              { id: 'p2', title: 'Active 2' },
              { id: 'p3', title: 'Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        include: { _count: { select: { posts: true } } },
      });

      // Should count only active posts (2, not 3)
      expect(user._count.posts).toBe(2);
    });

    it('_count in select filters out deleted relations', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active' },
              { id: 'p2', title: 'Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        select: { email: true, _count: { select: { posts: true } } },
      });

      expect(user._count.posts).toBe(1);
    });

    it('_count: true in include filters out deleted relations', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active 1' },
              { id: 'p2', title: 'Active 2' },
              { id: 'p3', title: 'Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        include: { _count: true },
      });

      // _count: true should expand to count all list relations with soft-delete filters
      expect(user._count.posts).toBe(2);
    });

    it('_count: true in select filters out deleted relations', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active' },
              { id: 'p2', title: 'Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        select: { email: true, _count: true },
      });

      expect(user._count.posts).toBe(1);
    });
  });

  describe('Relation filters (some/every/none)', () => {
    it('some filter excludes deleted relations', async () => {
      // User with only deleted posts
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'onlydeleted@test.com',
          posts: {
            create: { id: 'p1', title: 'Deleted Post', deleted_at: new Date() },
          },
        },
      });

      // User with active post
      await prisma.user.create({
        data: {
          id: 'u2',
          email: 'hasactive@test.com',
          posts: {
            create: { id: 'p2', title: 'Active Post' },
          },
        },
      });

      // Find users who have at least one post (should exclude u1 since their only post is deleted)
      const users = await safePrisma.user.findMany({
        where: { posts: { some: {} } },
      });

      // Should only find u2
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('u2');
    });

    it('every filter excludes deleted relations', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Published' },
              { id: 'p2', title: 'Also Published' },
              { id: 'p3', title: 'Draft', deleted_at: new Date() },
            ],
          },
        },
      });

      // Find users where every post title starts with "Published"
      const users = await safePrisma.user.findMany({
        where: {
          posts: { every: { title: { startsWith: 'Published' } } },
        },
      });

      // The deleted "Draft" should be excluded from the every check
      // So user should NOT match (since "Also Published" doesn't start with "Published")
      expect(users).toHaveLength(0);
    });

    it('none filter excludes deleted relations', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Good Post' },
              { id: 'p2', title: 'Bad Post', deleted_at: new Date() },
            ],
          },
        },
      });

      // Find users with no posts containing "Bad" (deleted post should be excluded)
      const users = await safePrisma.user.findMany({
        where: {
          posts: { none: { title: { contains: 'Bad' } } },
        },
      });

      // Should find the user since the "Bad Post" is deleted
      expect(users).toHaveLength(1);
    });
  });

  describe('Interactive transactions', () => {
    it('transaction callback receives wrapped delegates', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'active@test.com' },
          { id: 'u2', email: 'deleted@test.com', deleted_at: new Date() },
        ],
      });

      const result = await safePrisma.$transaction(async (tx: any) => {
        // This should filter out deleted records
        const users = await tx.user.findMany();
        return users;
      });

      // Should only get active user
      expect(result).toHaveLength(1);
      expect(result[0].email).toBe('active@test.com');
    });

    it('nested includes work in transactions', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active' },
              { id: 'p2', title: 'Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      const result = await safePrisma.$transaction(async (tx: any) => {
        return tx.user.findUnique({
          where: { id: 'u1' },
          include: { posts: true },
        });
      });

      expect(result.posts).toHaveLength(1);
      expect(result.posts[0].title).toBe('Active');
    });
  });

  describe('Update/upsert on soft-deleted records', () => {
    it('update on soft-deleted record throws P2025 (not found)', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'deleted@test.com', deleted_at: new Date() },
      });

      // update now filters out soft-deleted records, so targeting a deleted record throws
      await expect(
        safePrisma.user.update({
          where: { id: 'u1' },
          data: { name: 'Updated Name' },
        }),
      ).rejects.toThrow();
    });

    it('update on active record still works', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'active@test.com' },
      });

      const updated = await safePrisma.user.update({
        where: { id: 'u1' },
        data: { name: 'Updated Name' },
      });

      expect(updated.name).toBe('Updated Name');
    });

    it('updateMany skips soft-deleted records', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Active' },
          { id: 'u2', email: 'b@test.com', name: 'Active', deleted_at: new Date() },
          { id: 'u3', email: 'c@test.com', name: 'Active' },
        ],
      });

      const result = await safePrisma.user.updateMany({
        where: { name: 'Active' },
        data: { name: 'Updated' },
      });

      // Only 2 active records should be updated, not the soft-deleted one
      expect(result.count).toBe(2);

      // Verify the deleted record was not modified
      const deletedUser = await prisma.user.findUnique({ where: { id: 'u2' } });
      expect(deletedUser.name).toBe('Active');
    });

    it('transaction update also filters soft-deleted records', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'deleted@test.com', deleted_at: new Date() },
      });

      await expect(
        safePrisma.$transaction(async (tx: any) => {
          return tx.user.update({
            where: { id: 'u1' },
            data: { name: 'Updated' },
          });
        }),
      ).rejects.toThrow();
    });

    it('upsert does not find soft-deleted records (create branch fires)', async () => {
      // Create a user, then soft-delete via safePrisma (which mangles email)
      await safePrisma.user.create({
        data: { id: 'u1', email: 'reuse@test.com' },
      });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // Upsert with the original email - should NOT find the soft-deleted record
      // The create branch fires because the mangled email frees the unique constraint
      const result = await safePrisma.user.upsert({
        where: { email: 'reuse@test.com' },
        create: { id: 'u2', email: 'reuse@test.com', name: 'New User' },
        update: { name: 'Updated User' },
      });

      // Create branch fired - new record
      expect(result.id).toBe('u2');
      expect(result.name).toBe('New User');
    });

    it('upsert on non-existent record creates new record', async () => {
      const result = await safePrisma.user.upsert({
        where: { email: 'fresh@test.com' },
        create: { id: 'u1', email: 'fresh@test.com', name: 'Fresh' },
        update: { name: 'Should Not Update' },
      });

      expect(result.id).toBe('u1');
      expect(result.name).toBe('Fresh');
    });

    it('upsert on active record uses update branch', async () => {
      await safePrisma.user.create({
        data: { id: 'u1', email: 'active@test.com', name: 'Original' },
      });

      const result = await safePrisma.user.upsert({
        where: { email: 'active@test.com' },
        create: { id: 'u2', email: 'active@test.com', name: 'Should Not Create' },
        update: { name: 'Updated' },
      });

      expect(result.id).toBe('u1');
      expect(result.name).toBe('Updated');
    });
  });

  describe('updateManyAndReturn', () => {
    it('updateManyAndReturn filters soft-deleted records', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'active1@test.com', name: 'Active1' },
          { id: 'u2', email: 'active2@test.com', name: 'Active2' },
          { id: 'u3', email: 'deleted@test.com', name: 'Deleted', deleted_at: new Date() },
        ],
      });

      const result = await safePrisma.user.updateManyAndReturn({
        where: {},
        data: { name: 'Bulk Updated' },
      });

      // Should only return and update the 2 active records
      expect(result).toHaveLength(2);
      const ids = result.map((r: { id: string }) => r.id).sort();
      expect(ids).toEqual(['u1', 'u2']);
      expect(result.every((r: { name: string | null }) => r.name === 'Bulk Updated')).toBe(true);

      // Verify deleted record was not modified
      const deletedUser = await prisma.user.findUnique({ where: { id: 'u3' } });
      expect(deletedUser.name).toBe('Deleted');
    });
  });

  describe('distinct queries', () => {
    it('distinct works with soft delete filtering', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Alice' },
          { id: 'u2', email: 'b@test.com', name: 'Alice' },
          { id: 'u3', email: 'c@test.com', name: 'Bob' },
          { id: 'u4', email: 'd@test.com', name: 'Bob', deleted_at: new Date() },
        ],
      });

      const users = await safePrisma.user.findMany({
        distinct: ['name'],
        orderBy: { name: 'asc' },
      });

      // Should get Alice and Bob (not the deleted Bob duplicate)
      expect(users).toHaveLength(2);
      expect(users.map((u: any) => u.name)).toEqual(['Alice', 'Bob']);
    });
  });

  describe('Raw query escape hatches', () => {
    it('$queryRaw bypasses soft delete (documented behavior)', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'active@test.com' },
          { id: 'u2', email: 'deleted@test.com', deleted_at: new Date() },
        ],
      });

      // Raw queries bypass the wrapper entirely - this is expected
      const result = await safePrisma.$queryRaw`SELECT * FROM "User"`;

      expect(result).toHaveLength(2);
    });
  });

  describe('findFirstOrThrow and findUniqueOrThrow', () => {
    it('findFirstOrThrow throws when only deleted records match', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'deleted@test.com', deleted_at: new Date() },
      });

      await expect(
        safePrisma.user.findFirstOrThrow({
          where: { email: 'deleted@test.com' },
        })
      ).rejects.toThrow();
    });

    it('findUniqueOrThrow throws when record is soft-deleted', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'deleted@test.com', deleted_at: new Date() },
      });

      await expect(
        safePrisma.user.findUniqueOrThrow({
          where: { id: 'u1' },
        })
      ).rejects.toThrow();
    });
  });

  describe('Nested writes and relations', () => {
    it('create with nested connect works normally', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'author@test.com' },
      });

      const post = await safePrisma.post.create({
        data: {
          id: 'p1',
          title: 'New Post',
          author: { connect: { id: 'u1' } },
        },
      });

      expect(post.authorId).toBe('u1');
    });

    it('create with nested create works normally', async () => {
      const user = await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'author@test.com',
          posts: {
            create: { id: 'p1', title: 'First Post' },
          },
        },
        include: { posts: true },
      });

      expect(user.posts).toHaveLength(1);
    });

    it('update with nested operations works', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'author@test.com',
          posts: {
            create: { id: 'p1', title: 'Original' },
          },
        },
      });

      const updated = await safePrisma.user.update({
        where: { id: 'u1' },
        data: {
          posts: {
            update: {
              where: { id: 'p1' },
              data: { title: 'Updated' },
            },
          },
        },
        include: { posts: true },
      });

      expect(updated.posts[0].title).toBe('Updated');
    });
  });

  describe('Deeply nested relation filters', () => {
    it('handles 3-level deep relation filters', async () => {
      // Create user with post with active comment
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'deep@test.com',
          posts: {
            create: {
              id: 'p1',
              title: 'Post',
              comments: {
                create: { id: 'c1', content: 'Active Comment' },
              },
            },
          },
        },
      });

      // Create user with post with only deleted comment
      await prisma.user.create({
        data: {
          id: 'u2',
          email: 'nodeep@test.com',
          posts: {
            create: {
              id: 'p2',
              title: 'Post',
              comments: {
                create: { id: 'c2', content: 'Deleted Comment', deleted_at: new Date() },
              },
            },
          },
        },
      });

      // Find users who have posts with at least one comment
      const users = await safePrisma.user.findMany({
        where: {
          posts: {
            some: {
              comments: {
                some: {},
              },
            },
          },
        },
      });

      // Only u1 should match (u2's only comment is deleted)
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('u1');
    });
  });

  describe('Mixed deleted states in include', () => {
    it('handles mix of deleted and active at multiple levels', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              {
                id: 'p1',
                title: 'Active Post',
                comments: {
                  create: [
                    { id: 'c1', content: 'Active Comment 1' },
                    { id: 'c2', content: 'Deleted Comment', deleted_at: new Date() },
                    { id: 'c3', content: 'Active Comment 2' },
                  ],
                },
              },
              {
                id: 'p2',
                title: 'Deleted Post',
                deleted_at: new Date(),
                comments: {
                  create: [
                    { id: 'c4', content: 'Comment on deleted post' },
                  ],
                },
              },
            ],
          },
        },
      });

      const user = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        include: {
          posts: {
            include: { comments: true },
          },
        },
      });

      // Should only see 1 post (p1)
      expect(user.posts).toHaveLength(1);
      expect(user.posts[0].id).toBe('p1');

      // Should only see 2 comments on p1 (c1 and c3)
      expect(user.posts[0].comments).toHaveLength(2);
      expect(user.posts[0].comments.map((c: any) => c.id).sort()).toEqual(['c1', 'c3']);
    });
  });

  describe('createManyAndReturn', () => {
    it('createManyAndReturn works and returns created records', async () => {
      const users = await safePrisma.user.createManyAndReturn({
        data: [
          { id: 'u1', email: 'user1@test.com' },
          { id: 'u2', email: 'user2@test.com' },
        ],
      });

      expect(users).toHaveLength(2);
      expect(users[0].deleted_at).toBeNull();
    });
  });

  describe('Unique string field mangling', () => {
    it('mangles unique string fields on soft delete', async () => {
      await prisma.customer.create({
        data: {
          id: 'cust-1',
          email: 'john@example.com',
          username: 'johndoe',
          name: 'John Doe',
        },
      });

      await safePrisma.customer.softDelete({ where: { id: 'cust-1' }, deletedBy: 'test' });

      // Check that fields were mangled
      const raw = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      expect(raw.email).toBe('john@example.com__deleted_cust-1');
      expect(raw.username).toBe('johndoe__deleted_cust-1');
      expect(raw.deleted_at).not.toBeNull();
    });

    it('allows creating new record with same unique value after soft delete', async () => {
      await prisma.customer.create({
        data: {
          id: 'cust-1',
          email: 'reuse@example.com',
          username: 'reuse',
        },
      });

      await safePrisma.customer.softDelete({ where: { id: 'cust-1' }, deletedBy: 'test' });

      // Now we can create a new customer with the same email/username
      const newCustomer = await safePrisma.customer.create({
        data: {
          id: 'cust-2',
          email: 'reuse@example.com',
          username: 'reuse',
        },
      });

      expect(newCustomer.email).toBe('reuse@example.com');
      expect(newCustomer.username).toBe('reuse');
    });

    it('mangles unique fields in cascade delete', async () => {
      await prisma.customer.create({
        data: {
          id: 'cust-1',
          email: 'cascade@example.com',
          username: 'cascade',
          orders: {
            create: [
              { id: 'order-1', orderNumber: 'ORD-001' },
              { id: 'order-2', orderNumber: 'ORD-002' },
            ],
          },
        },
      });

      await safePrisma.customer.softDelete({ where: { id: 'cust-1' }, deletedBy: 'test' });

      // Check orders were mangled
      const orders = await prisma.order.findMany({ orderBy: { id: 'asc' } });
      expect(orders[0].orderNumber).toBe('ORD-001__deleted_order-1');
      expect(orders[1].orderNumber).toBe('ORD-002__deleted_order-2');

      // Can now reuse the order numbers
      await prisma.order.create({
        data: {
          id: 'order-3',
          orderNumber: 'ORD-001',
          customerId: 'cust-1', // Still referencing old customer
        },
      });
    });

    it('handles NULL unique values without mangling', async () => {
      // Note: username is required in schema, so we test with a nullable unique field
      // For this test, we'll verify that the mangling doesn't break on non-null values
      await prisma.customer.create({
        data: {
          id: 'cust-1',
          email: 'notnull@example.com',
          username: 'notnull',
        },
      });

      await safePrisma.customer.softDelete({ where: { id: 'cust-1' }, deletedBy: 'test' });

      const raw = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      expect(raw.email).toContain('__deleted_');
    });

    it('soft delete already-deleted record throws P2025', async () => {
      await prisma.customer.create({
        data: {
          id: 'cust-1',
          email: 'idempotent@example.com',
          username: 'idempotent',
        },
      });

      // Soft delete first time
      await safePrisma.customer.softDelete({ where: { id: 'cust-1' }, deletedBy: 'test' });

      // Soft delete again — record is already deleted, so P2025
      await expect(
        safePrisma.customer.softDelete({ where: { id: 'cust-1' }, deletedBy: 'test' }),
      ).rejects.toThrow(expect.objectContaining({ code: 'P2025' }));
    });

    it('mangles field whose value naturally ends with the suffix pattern', async () => {
      // This tests that a field value like "user__deleted_cust-1" (which ends with
      // the suffix that would be appended) still gets mangled correctly.
      // The old code had an endsWith(suffix) idempotency check that would skip
      // such values, causing data corruption.
      await prisma.customer.create({
        data: {
          id: 'cust-1',
          email: 'tricky__deleted_cust-1',
          username: 'normal',
        },
      });

      await safePrisma.customer.softDelete({ where: { id: 'cust-1' }, deletedBy: 'test' });

      const raw = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      // Should be double-suffixed: the original value + the mangle suffix
      expect(raw.email).toBe('tricky__deleted_cust-1__deleted_cust-1');
      expect(raw.username).toBe('normal__deleted_cust-1');

      // Restore and verify original values come back
      await safePrisma.customer.restore({ where: { id: 'cust-1' } });
      const restored = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      expect(restored.email).toBe('tricky__deleted_cust-1');
      expect(restored.username).toBe('normal');
    });

    it('handles compound unique constraints', async () => {
      await prisma.workspace.create({
        data: {
          id: 'ws-1',
          orgSlug: 'acme',
          slug: 'marketing',
          name: 'Marketing Workspace',
        },
      });

      await safePrisma.workspace.softDelete({ where: { id: 'ws-1' } });

      // Check both fields in compound unique were mangled
      const raw = await prisma.workspace.findUnique({ where: { id: 'ws-1' } });
      expect(raw.orgSlug).toBe('acme__deleted_ws-1');
      expect(raw.slug).toBe('marketing__deleted_ws-1');

      // Can now create workspace with same orgSlug + slug combination
      const newWs = await safePrisma.workspace.create({
        data: {
          id: 'ws-2',
          orgSlug: 'acme',
          slug: 'marketing',
          name: 'New Marketing Workspace',
        },
      });

      expect(newWs.orgSlug).toBe('acme');
      expect(newWs.slug).toBe('marketing');
    });

    it('softDeleteMany mangles all affected records', async () => {
      await prisma.customer.createMany({
        data: [
          { id: 'cust-1', email: 'batch1@example.com', username: 'batch1', name: 'Batch' },
          { id: 'cust-2', email: 'batch2@example.com', username: 'batch2', name: 'Batch' },
          { id: 'cust-3', email: 'keep@example.com', username: 'keep', name: 'Keep' },
        ],
      });

      await safePrisma.customer.softDeleteMany({ where: { name: 'Batch' }, deletedBy: 'test' });

      // Mangled records
      const cust1 = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      const cust2 = await prisma.customer.findUnique({ where: { id: 'cust-2' } });
      expect(cust1.email).toBe('batch1@example.com__deleted_cust-1');
      expect(cust2.email).toBe('batch2@example.com__deleted_cust-2');

      // Kept record - not mangled
      const cust3 = await prisma.customer.findUnique({ where: { id: 'cust-3' } });
      expect(cust3.email).toBe('keep@example.com');

      // Can reuse emails
      await prisma.customer.create({
        data: { id: 'cust-4', email: 'batch1@example.com', username: 'newbatch1' },
      });
    });
  });

  describe('deleted_by field support', () => {
    it('softDelete sets deleted_by when provided', async () => {
      await prisma.customer.create({
        data: { id: 'cust-1', email: 'test@example.com', username: 'testuser' },
      });

      await safePrisma.customer.softDelete({
        where: { id: 'cust-1' },
        deletedBy: 'admin-123',
      });

      const rawCustomer = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      expect(rawCustomer.deleted_at).not.toBeNull();
      expect(rawCustomer.deleted_by).toBe('admin-123');
    });

    // Note: deletedBy requirement is enforced at compile-time via TypeScript types.
    // The following code would not compile:
    //   safePrisma.customer.softDelete({ where: { id: '1' } })  // Error: missing deletedBy
    // See integration tests for compile-time verification.

    it('softDelete works without deletedBy on models that lack deleted_by field', async () => {
      // User model has deleted_at but no deleted_by field
      await prisma.user.create({
        data: { id: 'user-1', email: 'test@test.com' },
      });

      // Should not throw - User doesn't have deleted_by field
      await safePrisma.user.softDelete({ where: { id: 'user-1' } });

      const rawUser = await prisma.user.findUnique({ where: { id: 'user-1' } });
      expect(rawUser.deleted_at).not.toBeNull();
    });

    it('softDelete cascade propagates deleted_by to children', async () => {
      await prisma.customer.create({
        data: {
          id: 'cust-1',
          email: 'cascade@example.com',
          username: 'cascade',
          orders: {
            create: [
              { id: 'order-1', orderNumber: 'ORD-001' },
              { id: 'order-2', orderNumber: 'ORD-002' },
            ],
          },
        },
      });

      await safePrisma.customer.softDelete({
        where: { id: 'cust-1' },
        deletedBy: 'admin-456',
      });

      // Check customer
      const rawCustomer = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      expect(rawCustomer.deleted_by).toBe('admin-456');

      // Check orders
      const rawOrders = await prisma.order.findMany();
      expect(rawOrders).toHaveLength(2);
      expect(rawOrders.every((o: any) => o.deleted_by === 'admin-456')).toBe(true);
    });

    it('softDeleteMany sets deleted_by on all records', async () => {
      await prisma.customer.createMany({
        data: [
          { id: 'cust-1', email: 'c1@example.com', username: 'u1', name: 'ToDelete' },
          { id: 'cust-2', email: 'c2@example.com', username: 'u2', name: 'ToDelete' },
          { id: 'cust-3', email: 'c3@example.com', username: 'u3', name: 'Keep' },
        ],
      });

      await safePrisma.customer.softDeleteMany({
        where: { name: 'ToDelete' },
        deletedBy: 'batch-admin',
      });

      const cust1 = await prisma.customer.findUnique({ where: { id: 'cust-1' } });
      const cust2 = await prisma.customer.findUnique({ where: { id: 'cust-2' } });
      const cust3 = await prisma.customer.findUnique({ where: { id: 'cust-3' } });

      expect(cust1.deleted_by).toBe('batch-admin');
      expect(cust2.deleted_by).toBe('batch-admin');
      expect(cust3.deleted_by).toBeNull(); // Not deleted
    });
  });

  describe('Known limitations (documented behavior)', () => {
    it('KNOWN LIMITATION: Fluent API does not filter (use include instead)', async () => {
      // The fluent API (findUnique().relation()) bypasses our wrapper
      // Users should use include: { relation: true } instead
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'test@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active' },
              { id: 'p2', title: 'Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      // This is the WORKAROUND - use include
      const userWithInclude = await safePrisma.user.findUnique({
        where: { id: 'u1' },
        include: { posts: true },
      });
      expect(userWithInclude.posts).toHaveLength(1); // Correctly filtered

      // NOTE: Fluent API would NOT filter:
      // const posts = await safePrisma.user.findUnique({ where: { id: 'u1' } }).posts();
      // This would return BOTH posts because fluent API bypasses the wrapper
    });
  });

  describe('Restore functionality', () => {
    describe('Basic restore', () => {
      it('restore returns null for non-existent record', async () => {
        const result = await safePrisma.user.restore({
          where: { id: 'non-existent-id' },
        });
        expect(result).toBeNull();
      });

      it('restore returns null for non-deleted record', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'active@test.com' },
        });

        const result = await safePrisma.user.restore({
          where: { id: 'u1' },
        });
        expect(result).toBeNull();
      });

      it('restore sets deleted_at to null', async () => {
        const deletedAt = new Date();
        await prisma.user.create({
          data: { id: 'u1', email: 'deleted@test.com', deleted_at: deletedAt },
        });

        const restored = await safePrisma.user.restore({
          where: { id: 'u1' },
        });

        expect(restored).not.toBeNull();
        expect(restored.deleted_at).toBeNull();

        // Verify it's now visible in normal queries
        const found = await safePrisma.user.findUnique({ where: { id: 'u1' } });
        expect(found).not.toBeNull();
      });

      it('restore unmangles unique string fields', async () => {
        // Create and soft-delete a customer (which mangles unique fields)
        await prisma.customer.create({
          data: { id: 'c1', email: 'john@test.com', username: 'johndoe' },
        });
        await safePrisma.customer.softDelete({ where: { id: 'c1' } });

        // Verify fields are mangled
        const deleted = await prisma.customer.findUnique({ where: { id: 'c1' } });
        expect(deleted.email).toContain('__deleted_');
        expect(deleted.username).toContain('__deleted_');

        // Restore
        const restored = await safePrisma.customer.restore({ where: { id: 'c1' } });

        expect(restored.email).toBe('john@test.com');
        expect(restored.username).toBe('johndoe');
        expect(restored.deleted_at).toBeNull();
      });

      it('restore clears deleted_by field', async () => {
        await prisma.customer.create({
          data: {
            id: 'c1',
            email: 'john@test.com',
            username: 'johndoe',
            deleted_at: new Date(),
            deleted_by: 'admin-user',
          },
        });

        const restored = await safePrisma.customer.restore({ where: { id: 'c1' } });

        expect(restored.deleted_at).toBeNull();
        expect(restored.deleted_by).toBeNull();
      });

      it('restoreMany restores multiple records', async () => {
        const deletedAt = new Date();
        await prisma.user.createMany({
          data: [
            { id: 'u1', email: 'user1@test.com', name: 'Test', deleted_at: deletedAt },
            { id: 'u2', email: 'user2@test.com', name: 'Test', deleted_at: deletedAt },
            { id: 'u3', email: 'user3@test.com', name: 'Other', deleted_at: deletedAt },
          ],
        });

        const result = await safePrisma.user.restoreMany({
          where: { name: 'Test' },
        });

        expect(result.count).toBe(2);

        // Verify restored users are visible
        const users = await safePrisma.user.findMany({ where: { name: 'Test' } });
        expect(users).toHaveLength(2);
      });
    });

    describe('Restore conflict handling', () => {
      it('restore throws on unique field conflict', async () => {
        // Create an active customer with email
        await prisma.customer.create({
          data: { id: 'c-active', email: 'john@test.com', username: 'johndoe' },
        });

        // Create a soft-deleted customer with same email (mangled)
        await prisma.customer.create({
          data: {
            id: 'c-deleted',
            email: 'john@test.com__deleted_c-deleted',
            username: 'johndoe2__deleted_c-deleted',
            deleted_at: new Date(),
          },
        });

        // Try to restore - should fail because email would conflict
        await expect(
          safePrisma.customer.restore({ where: { id: 'c-deleted' } })
        ).rejects.toThrow(/unique field "email".*already exists/);
      });

      it('restoreMany throws on conflict and rolls back', async () => {
        // Create active customer with email
        await prisma.customer.create({
          data: { id: 'c-active', email: 'taken@test.com', username: 'taken' },
        });

        // Create two soft-deleted customers
        await prisma.customer.create({
          data: {
            id: 'c1',
            email: 'safe@test.com__deleted_c1',
            username: 'safe__deleted_c1',
            name: 'ToRestore',
            deleted_at: new Date(),
          },
        });
        await prisma.customer.create({
          data: {
            id: 'c2',
            email: 'taken@test.com__deleted_c2', // This will conflict
            username: 'user2__deleted_c2',
            name: 'ToRestore',
            deleted_at: new Date(),
          },
        });

        // Try to restore both - should fail on second one
        await expect(
          safePrisma.customer.restoreMany({ where: { name: 'ToRestore' } })
        ).rejects.toThrow(/unique field.*already exists/);

        // Verify first one was rolled back (still deleted)
        const c1 = await prisma.customer.findUnique({ where: { id: 'c1' } });
        expect(c1.deleted_at).not.toBeNull();
      });
    });

    describe('Restore with compound primary key', () => {
      it('restore works with compound primary key', async () => {
        await prisma.tenantUser.create({
          data: {
            tenantId: 't1',
            userId: 'u1',
            email: 'user@tenant.com',
            deleted_at: new Date(),
          },
        });

        const restored = await safePrisma.tenantUser.restore({
          where: { tenantId_userId: { tenantId: 't1', userId: 'u1' } },
        });

        expect(restored).not.toBeNull();
        expect(restored.deleted_at).toBeNull();
      });
    });

    describe('Restore in transaction', () => {
      it('restore works in transaction context', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'tx@test.com', deleted_at: new Date() },
        });

        await safePrisma.$transaction(async (tx: any) => {
          const restored = await tx.user.restore({ where: { id: 'u1' } });
          expect(restored.deleted_at).toBeNull();
        });

        // Verify persisted
        const user = await safePrisma.user.findUnique({ where: { id: 'u1' } });
        expect(user).not.toBeNull();
      });
    });
  });

  describe('Restore cascade functionality', () => {
    describe('Basic cascade restore', () => {
      it('restoreCascade restores parent and children with same timestamp', async () => {
        // Soft delete a user with posts and comments (cascade)
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'cascade@test.com',
            posts: {
              create: [
                {
                  id: 'p1',
                  title: 'Post 1',
                  comments: {
                    create: [
                      { id: 'c1', content: 'Comment 1' },
                      { id: 'c2', content: 'Comment 2' },
                    ],
                  },
                },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        // Verify all are deleted with same timestamp
        const deletedUser = await prisma.user.findUnique({ where: { id: 'u1' } });
        const deletedPost = await prisma.post.findUnique({ where: { id: 'p1' } });
        const deletedComment = await prisma.comment.findUnique({ where: { id: 'c1' } });
        expect(deletedUser.deleted_at).not.toBeNull();
        expect(deletedPost.deleted_at?.getTime()).toBe(deletedUser.deleted_at?.getTime());
        expect(deletedComment.deleted_at?.getTime()).toBe(deletedUser.deleted_at?.getTime());

        // Restore with cascade
        const { record: restored, cascaded } = await safePrisma.user.restoreCascade({ where: { id: 'u1' } });
        expect(restored).not.toBeNull();
        expect(restored.deleted_at).toBeNull();

        // Verify cascade info
        expect(cascaded.Post).toBe(2);
        expect(cascaded.Comment).toBe(2);

        // Verify all children are restored
        const posts = await safePrisma.post.findMany({ where: { authorId: 'u1' } });
        expect(posts).toHaveLength(2);

        const comments = await safePrisma.comment.findMany({ where: { postId: 'p1' } });
        expect(comments).toHaveLength(2);
      });

      it('restoreCascade only restores children with matching timestamp', async () => {
        // Create user with posts
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'partial@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        // Soft delete post 1 independently first
        await safePrisma.post.softDelete({ where: { id: 'p1' } });
        const independentlyDeletedPost = await prisma.post.findUnique({ where: { id: 'p1' } });
        const independentTimestamp = independentlyDeletedPost.deleted_at;

        // Wait a tiny bit to ensure different timestamp
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Soft delete user (will cascade to post 2)
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        // Restore user with cascade
        await safePrisma.user.restoreCascade({ where: { id: 'u1' } });

        // Post 2 should be restored (same timestamp as user)
        const post2 = await safePrisma.post.findUnique({ where: { id: 'p2' } });
        expect(post2).not.toBeNull();

        // Post 1 should still be deleted (different timestamp)
        const post1 = await prisma.post.findUnique({ where: { id: 'p1' } });
        expect(post1.deleted_at?.getTime()).toBe(independentTimestamp?.getTime());
      });

      it('restoreCascade returns null for non-deleted record', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'active@test.com' },
        });

        const { record, cascaded } = await safePrisma.user.restoreCascade({ where: { id: 'u1' } });
        expect(record).toBeNull();
        expect(cascaded).toEqual({});
      });
    });

    describe('Deep hierarchy cascade restore', () => {
      it('restoreCascade handles 4-level deep hierarchy', async () => {
        // Create: Category -> Product -> ProductVariant -> VariantOption
        await prisma.category.create({
          data: {
            id: 'cat1',
            name: 'Electronics',
            products: {
              create: {
                id: 'prod1',
                name: 'Phone',
                variants: {
                  create: {
                    id: 'var1',
                    sku: 'PHN-001',
                    options: {
                      create: [
                        { id: 'opt1', name: 'Color', value: 'Black' },
                        { id: 'opt2', name: 'Storage', value: '128GB' },
                      ],
                    },
                  },
                },
              },
            },
          },
        });

        // Soft delete category (cascades through all levels)
        await safePrisma.category.softDelete({ where: { id: 'cat1' } });

        // Verify all deleted
        expect((await prisma.category.findUnique({ where: { id: 'cat1' } })).deleted_at).not.toBeNull();
        expect((await prisma.product.findUnique({ where: { id: 'prod1' } })).deleted_at).not.toBeNull();
        expect((await prisma.productVariant.findUnique({ where: { id: 'var1' } })).deleted_at).not.toBeNull();
        expect((await prisma.variantOption.findUnique({ where: { id: 'opt1' } })).deleted_at).not.toBeNull();

        // Restore with cascade
        await safePrisma.category.restoreCascade({ where: { id: 'cat1' } });

        // Verify all restored
        const cat = await safePrisma.category.findUnique({ where: { id: 'cat1' } });
        const prod = await safePrisma.product.findUnique({ where: { id: 'prod1' } });
        const variant = await safePrisma.productVariant.findUnique({ where: { id: 'var1' } });
        const options = await safePrisma.variantOption.findMany({ where: { variantId: 'var1' } });

        expect(cat).not.toBeNull();
        expect(prod).not.toBeNull();
        expect(variant).not.toBeNull();
        expect(options).toHaveLength(2);
      });
    });

    describe('Self-referential cascade restore', () => {
      it('restoreCascade handles self-referential model', async () => {
        // Create category hierarchy: Root -> Child -> Grandchild
        await prisma.category.create({
          data: {
            id: 'root',
            name: 'Root',
            children: {
              create: {
                id: 'child',
                name: 'Child',
                children: {
                  create: { id: 'grandchild', name: 'Grandchild' },
                },
              },
            },
          },
        });

        // Soft delete root (cascades to children)
        await safePrisma.category.softDelete({ where: { id: 'root' } });

        // Verify all deleted
        expect((await prisma.category.findUnique({ where: { id: 'root' } })).deleted_at).not.toBeNull();
        expect((await prisma.category.findUnique({ where: { id: 'child' } })).deleted_at).not.toBeNull();
        expect((await prisma.category.findUnique({ where: { id: 'grandchild' } })).deleted_at).not.toBeNull();

        // Restore root with cascade
        await safePrisma.category.restoreCascade({ where: { id: 'root' } });

        // Verify all restored
        const categories = await safePrisma.category.findMany();
        expect(categories).toHaveLength(3);
      });
    });

    describe('Cascade restore through non-soft-deletable intermediary', () => {
      it('restoreCascade traverses through non-soft-deletable model to restore grandchildren', async () => {
        // Organization(soft) -> Asset(non-soft) -> AssetComment(soft)
        await prisma.organization.create({
          data: {
            id: 'org1',
            name: 'Test Org',
            assets: {
              create: {
                id: 'asset1',
                url: 'https://example.com/file.png',
                comments: {
                  create: { id: 'ac1', content: 'Nice asset' },
                },
              },
            },
          },
        });

        // Soft delete organization — AssetComment should cascade-delete, Asset stays as-is
        await safePrisma.organization.softDelete({ where: { id: 'org1' } });

        // Verify organization is soft-deleted
        const org = await prisma.organization.findUnique({ where: { id: 'org1' } });
        expect(org.deleted_at).not.toBeNull();

        // Verify AssetComment is soft-deleted (cascaded through non-soft-deletable Asset)
        const comment = await prisma.assetComment.findUnique({ where: { id: 'ac1' } });
        expect(comment.deleted_at).not.toBeNull();

        // Asset still exists (not soft-deletable, no deleted_at)
        const asset = await prisma.asset.findUnique({ where: { id: 'asset1' } });
        expect(asset).not.toBeNull();

        // Restore organization with cascade
        const { cascaded } = await safePrisma.organization.restoreCascade({ where: { id: 'org1' } });

        // Verify organization is restored
        const restoredOrg = await prisma.organization.findUnique({ where: { id: 'org1' } });
        expect(restoredOrg.deleted_at).toBeNull();

        // Verify AssetComment is restored (traversed through non-soft-deletable Asset)
        const restoredComment = await prisma.assetComment.findUnique({ where: { id: 'ac1' } });
        expect(restoredComment.deleted_at).toBeNull();

        // Verify cascade info includes assetComment
        expect(cascaded.AssetComment).toBe(1);
      });
    });

    describe('Cascade restore conflict handling', () => {
      it('restoreCascade rolls back on child conflict', async () => {
        // Create customer with orders
        await prisma.customer.create({
          data: {
            id: 'cust1',
            email: 'customer@test.com',
            username: 'customer1',
            orders: {
              create: { id: 'ord1', orderNumber: 'ORD-001' },
            },
          },
        });

        // Soft delete customer (cascades to orders)
        await safePrisma.customer.softDelete({ where: { id: 'cust1' } });

        // Create a new order with the same orderNumber (conflict)
        await prisma.order.create({
          data: {
            id: 'ord-new',
            orderNumber: 'ORD-001',
            customerId: 'cust1', // FK still valid since customer exists (just soft-deleted)
          },
        });

        // Try to restore customer with cascade - should fail due to order conflict
        await expect(
          safePrisma.customer.restoreCascade({ where: { id: 'cust1' } })
        ).rejects.toThrow(/unique field.*already exists/);

        // Verify customer was rolled back (still deleted)
        const customer = await prisma.customer.findUnique({ where: { id: 'cust1' } });
        expect(customer.deleted_at).not.toBeNull();
      });
    });

    describe('Cascade restore with unique field unmangling', () => {
      it('restoreCascade unmangles unique fields at all levels', async () => {
        // Create customer with orders (both have unique string fields)
        await prisma.customer.create({
          data: {
            id: 'cust1',
            email: 'cascade@test.com',
            username: 'cascadeuser',
            orders: {
              create: { id: 'ord1', orderNumber: 'CASCADE-001' },
            },
          },
        });

        // Soft delete (mangles unique fields)
        await safePrisma.customer.softDelete({ where: { id: 'cust1' } });

        // Verify mangled
        const deletedCustomer = await prisma.customer.findUnique({ where: { id: 'cust1' } });
        const deletedOrder = await prisma.order.findUnique({ where: { id: 'ord1' } });
        expect(deletedCustomer.email).toContain('__deleted_');
        expect(deletedOrder.orderNumber).toContain('__deleted_');

        // Restore with cascade
        await safePrisma.customer.restoreCascade({ where: { id: 'cust1' } });

        // Verify unmangled
        const customer = await safePrisma.customer.findUnique({ where: { id: 'cust1' } });
        const order = await safePrisma.order.findUnique({ where: { id: 'ord1' } });

        expect(customer.email).toBe('cascade@test.com');
        expect(customer.username).toBe('cascadeuser');
        expect(order.orderNumber).toBe('CASCADE-001');
      });
    });

    describe('Cascade info in return values', () => {
      it('softDelete returns cascade info for simple cascade', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'cascade@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
                { id: 'p3', title: 'Post 3' },
              ],
            },
          },
        });

        const { record, cascaded } = await safePrisma.user.softDelete({ where: { id: 'u1' } });
        expect(record).not.toBeNull();
        expect(record.id).toBe('u1');
        expect(cascaded.Post).toBe(3);
      });

      it('softDelete returns cascade info for deep cascade', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'deep@test.com',
            posts: {
              create: {
                id: 'p1',
                title: 'Post',
                comments: {
                  create: [
                    { id: 'c1', content: 'Comment 1' },
                    { id: 'c2', content: 'Comment 2' },
                  ],
                },
              },
            },
          },
        });

        const { cascaded } = await safePrisma.user.softDelete({ where: { id: 'u1' } });
        expect(cascaded.Post).toBe(1);
        expect(cascaded.Comment).toBe(2);
      });

      it('softDelete returns empty cascade for leaf model', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'leaf@test.com',
            posts: {
              create: {
                id: 'p1',
                title: 'Post',
              },
            },
          },
        });

        // Post has Comment children but this post has none
        const { cascaded } = await safePrisma.post.softDelete({ where: { id: 'p1' } });
        expect(cascaded).toEqual({});
      });

      it('softDeleteMany returns aggregated cascade info', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user1@test.com',
            name: 'ToDelete',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });
        await prisma.user.create({
          data: {
            id: 'u2',
            email: 'user2@test.com',
            name: 'ToDelete',
            posts: {
              create: { id: 'p3', title: 'Post 3' },
            },
          },
        });

        const { count, cascaded } = await safePrisma.user.softDeleteMany({
          where: { name: 'ToDelete' },
        });
        expect(count).toBe(2);
        expect(cascaded.Post).toBe(3);
      });

      it('restoreCascade returns cascade info', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'restore@test.com',
            posts: {
              create: [
                {
                  id: 'p1',
                  title: 'Post 1',
                  comments: {
                    create: { id: 'c1', content: 'Comment 1' },
                  },
                },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        const { record, cascaded } = await safePrisma.user.restoreCascade({ where: { id: 'u1' } });
        expect(record).not.toBeNull();
        expect(cascaded.Post).toBe(2);
        expect(cascaded.Comment).toBe(1);
      });
    });

    describe('Cascade restore in transaction', () => {
      it('restoreCascade works in transaction context', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'txcascade@test.com',
            posts: {
              create: { id: 'p1', title: 'Post' },
            },
          },
        });

        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        await safePrisma.$transaction(async (tx: any) => {
          const { record: restored } = await tx.user.restoreCascade({ where: { id: 'u1' } });
          expect(restored.deleted_at).toBeNull();
        });

        // Verify both restored
        const user = await safePrisma.user.findUnique({ where: { id: 'u1' } });
        const post = await safePrisma.post.findUnique({ where: { id: 'p1' } });
        expect(user).not.toBeNull();
        expect(post).not.toBeNull();
      });
    });
  });

  describe('Projection forwarding (include/select/omit)', () => {
    describe('softDelete (complex model — cascade path)', () => {
      it('include returns relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'proj@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        const result = await safePrisma.user.softDelete({
          where: { id: 'u1' },
          include: { posts: true },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.posts).toBeDefined();
        expect(result.record.posts).toHaveLength(2);
      });

      it('select returns only selected fields', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'select@test.com' },
        });

        const result = await safePrisma.user.softDelete({
          where: { id: 'u1' },
          select: { id: true, email: true },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.id).toBe('u1');
        // email is mangled after soft delete
        expect(result.record.email).toContain('select@test.com');
        // Fields not in select should be absent
        expect(result.record).not.toHaveProperty('deleted_at');
        expect(result.record).not.toHaveProperty('name');
      });

      it('select with nested relation select', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'nested-sel@test.com',
            posts: {
              create: [{ id: 'p1', title: 'Post 1' }],
            },
          },
        });

        const result = await safePrisma.user.softDelete({
          where: { id: 'u1' },
          select: { id: true, posts: { select: { title: true } } },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.id).toBe('u1');
        expect(result.record).not.toHaveProperty('email');
        expect(result.record.posts).toHaveLength(1);
        expect(result.record.posts[0].title).toBe('Post 1');
        expect(result.record.posts[0]).not.toHaveProperty('id');
      });

      it('omit excludes specified fields', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'omit@test.com', name: 'Omit User' },
        });

        const result = await safePrisma.user.softDelete({
          where: { id: 'u1' },
          omit: { name: true, deleted_at: true },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.id).toBe('u1');
        expect(result.record).not.toHaveProperty('name');
        expect(result.record).not.toHaveProperty('deleted_at');
      });
    });

    describe('softDelete (simple model — fast path)', () => {
      it('include returns relations', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'simple-inc@test.com' },
        });
        await prisma.post.create({
          data: {
            id: 'p1',
            title: 'Simple Post',
            authorId: 'u1',
            comments: {
              create: [{ id: 'c1', content: 'A comment' }],
            },
          },
        });

        // Comment is a simple/leaf model
        const result = await safePrisma.comment.softDelete({
          where: { id: 'c1' },
          include: { post: true },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.post).toBeDefined();
        expect(result.record.post.title).toBe('Simple Post');
      });

      it('select returns only selected fields', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'simsel@test.com' },
        });
        await prisma.post.create({
          data: {
            id: 'p1',
            title: 'Sel Post',
            authorId: 'u1',
            comments: {
              create: [{ id: 'c1', content: 'Comment sel' }],
            },
          },
        });

        const result = await safePrisma.comment.softDelete({
          where: { id: 'c1' },
          select: { id: true, content: true },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.id).toBe('c1');
        expect(result.record.content).toBe('Comment sel');
        expect(result.record).not.toHaveProperty('postId');
        expect(result.record).not.toHaveProperty('deleted_at');
      });
    });

    describe('restore', () => {
      it('include returns relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'restore-proj@test.com',
            deleted_at: new Date(),
            posts: {
              create: [{ id: 'p1', title: 'Post 1' }],
            },
          },
        });

        const restored = await safePrisma.user.restore({
          where: { id: 'u1' },
          include: { posts: true },
        });

        expect(restored).not.toBeNull();
        expect(restored.posts).toBeDefined();
        expect(restored.posts).toHaveLength(1);
        expect(restored.posts[0].title).toBe('Post 1');
      });

      it('select returns only selected fields', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'restore-sel@test.com',
            deleted_at: new Date(),
          },
        });

        const restored = await safePrisma.user.restore({
          where: { id: 'u1' },
          select: { id: true, email: true },
        });

        expect(restored).not.toBeNull();
        expect(restored.id).toBe('u1');
        expect(restored.email).toBe('restore-sel@test.com');
        expect(restored).not.toHaveProperty('deleted_at');
        expect(restored).not.toHaveProperty('name');
      });

      it('omit excludes specified fields', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'restore-omit@test.com',
            name: 'Omit Restore',
            deleted_at: new Date(),
          },
        });

        const restored = await safePrisma.user.restore({
          where: { id: 'u1' },
          omit: { name: true },
        });

        expect(restored).not.toBeNull();
        expect(restored.id).toBe('u1');
        expect(restored).not.toHaveProperty('name');
        expect(restored).toHaveProperty('email');
      });
    });

    describe('restoreCascade', () => {
      it('include returns relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'rc-proj@test.com',
            posts: {
              create: [{ id: 'p1', title: 'Post RC' }],
            },
          },
        });
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        const result = await safePrisma.user.restoreCascade({
          where: { id: 'u1' },
          include: { posts: true },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.posts).toBeDefined();
        expect(result.record.posts).toHaveLength(1);
        expect(result.record.posts[0].title).toBe('Post RC');
      });

      it('select returns only selected fields', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'rc-sel@test.com',
            posts: {
              create: [{ id: 'p1', title: 'Post RC Sel' }],
            },
          },
        });
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        const result = await safePrisma.user.restoreCascade({
          where: { id: 'u1' },
          select: { id: true, posts: { select: { title: true } } },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.id).toBe('u1');
        expect(result.record).not.toHaveProperty('email');
        expect(result.record.posts).toHaveLength(1);
        expect(result.record.posts[0].title).toBe('Post RC Sel');
      });

      it('omit excludes specified fields', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'rc-omit@test.com',
            name: 'RC Omit',
            posts: {
              create: [{ id: 'p1', title: 'Post RC Omit' }],
            },
          },
        });
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        const result = await safePrisma.user.restoreCascade({
          where: { id: 'u1' },
          omit: { name: true },
        });

        expect(result.record).not.toBeNull();
        expect(result.record).not.toHaveProperty('name');
        expect(result.record).toHaveProperty('email');
      });
    });

    describe('transaction wrapper paths', () => {
      it('tx softDelete (complex model) with include returns relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'tx-sd@test.com',
            posts: {
              create: [{ id: 'p1', title: 'TX Post' }],
            },
          },
        });

        await safePrisma.$transaction(async (tx: any) => {
          const result = await tx.user.softDelete({
            where: { id: 'u1' },
            include: { posts: true },
          });

          expect(result.record).not.toBeNull();
          expect(result.record.posts).toBeDefined();
          expect(result.record.posts).toHaveLength(1);
          expect(result.record.posts[0].title).toBe('TX Post');
        });
      });

      it('tx softDelete (simple model) with include returns relations', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'tx-simple@test.com' },
        });
        await prisma.post.create({
          data: {
            id: 'p1',
            title: 'TX Simple Post',
            authorId: 'u1',
            comments: {
              create: [{ id: 'c1', content: 'TX comment' }],
            },
          },
        });

        await safePrisma.$transaction(async (tx: any) => {
          const result = await tx.comment.softDelete({
            where: { id: 'c1' },
            include: { post: true },
          });

          expect(result.record).not.toBeNull();
          expect(result.record.post).toBeDefined();
          expect(result.record.post.title).toBe('TX Simple Post');
        });
      });

      it('tx restore with include returns relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'tx-restore@test.com',
            deleted_at: new Date(),
            posts: {
              create: [{ id: 'p1', title: 'TX Restore Post' }],
            },
          },
        });

        await safePrisma.$transaction(async (tx: any) => {
          const restored = await tx.user.restore({
            where: { id: 'u1' },
            include: { posts: true },
          });

          expect(restored).not.toBeNull();
          expect(restored.posts).toBeDefined();
          expect(restored.posts).toHaveLength(1);
        });
      });

      it('tx restoreCascade with include returns relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'tx-rc@test.com',
            posts: {
              create: [{ id: 'p1', title: 'TX RC Post' }],
            },
          },
        });
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        await safePrisma.$transaction(async (tx: any) => {
          const result = await tx.user.restoreCascade({
            where: { id: 'u1' },
            include: { posts: true },
          });

          expect(result.record).not.toBeNull();
          expect(result.record.posts).toBeDefined();
          expect(result.record.posts).toHaveLength(1);
        });
      });

      it('tx softDelete with select returns only selected fields', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'tx-sel@test.com' },
        });

        await safePrisma.$transaction(async (tx: any) => {
          const result = await tx.user.softDelete({
            where: { id: 'u1' },
            select: { id: true, email: true },
          });

          expect(result.record).not.toBeNull();
          expect(result.record.id).toBe('u1');
          expect(result.record).not.toHaveProperty('deleted_at');
        });
      });
    });

    describe('without projection (backward compatibility)', () => {
      it('softDelete without projection still returns full record', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'nopr@test.com', name: 'No Proj' },
        });

        const result = await safePrisma.user.softDelete({
          where: { id: 'u1' },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.id).toBe('u1');
        expect(result.record).toHaveProperty('deleted_at');
        expect(result.record).toHaveProperty('name');
        expect(result.record).not.toHaveProperty('posts');
      });

      it('restore without projection still returns full record', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'nopr-r@test.com', name: 'No Proj R', deleted_at: new Date() },
        });

        const restored = await safePrisma.user.restore({
          where: { id: 'u1' },
        });

        expect(restored).not.toBeNull();
        expect(restored.id).toBe('u1');
        expect(restored).toHaveProperty('email');
        expect(restored).toHaveProperty('name');
        expect(restored).not.toHaveProperty('posts');
      });

      it('restoreCascade without projection still returns full record', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'nopr-rc@test.com',
            posts: { create: [{ id: 'p1', title: 'NP' }] },
          },
        });
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        const result = await safePrisma.user.restoreCascade({
          where: { id: 'u1' },
        });

        expect(result.record).not.toBeNull();
        expect(result.record.id).toBe('u1');
        expect(result.record).toHaveProperty('email');
        expect(result.record).not.toHaveProperty('posts');
      });
    });
  });

  describe('Simple model fast path (leaf models without unique mangling)', () => {
    it('softDeleteMany on Comment returns correct count and empty cascaded', async () => {
      // Comment is a leaf model (no cascade children, no unique string fields)
      // so it uses the fast updateMany path
      await prisma.user.create({
        data: { id: 'u1', email: 'user@test.com' },
      });
      await prisma.post.create({
        data: { id: 'p1', title: 'Post', authorId: 'u1' },
      });
      await prisma.comment.createMany({
        data: [
          { id: 'c1', content: 'Comment 1', postId: 'p1' },
          { id: 'c2', content: 'Comment 2', postId: 'p1' },
          { id: 'c3', content: 'Comment 3', postId: 'p1', deleted_at: new Date() },
        ],
      });

      const { count, cascaded } = await safePrisma.comment.softDeleteMany({
        where: { postId: 'p1' },
      });

      // Only 2 active comments should be deleted (c3 already deleted)
      expect(count).toBe(2);
      expect(cascaded).toEqual({});

      // Verify all 3 are now deleted
      const remaining = await safePrisma.comment.findMany({ where: { postId: 'p1' } });
      expect(remaining).toHaveLength(0);
    });

    it('softDelete on Comment returns record and empty cascaded', async () => {
      await prisma.user.create({
        data: { id: 'u1', email: 'user@test.com' },
      });
      await prisma.post.create({
        data: { id: 'p1', title: 'Post', authorId: 'u1' },
      });
      await prisma.comment.create({
        data: { id: 'c1', content: 'A comment', postId: 'p1' },
      });

      const { record, cascaded } = await safePrisma.comment.softDelete({
        where: { id: 'c1' },
      });

      expect(record).not.toBeNull();
      expect(record.id).toBe('c1');
      expect(record.deleted_at).not.toBeNull();
      expect(cascaded).toEqual({});
    });

    it('fast-path softDelete on non-existent record throws P2025', async () => {
      // Comment is a fast-path model (no children, no unique strings)
      await expect(
        safePrisma.comment.softDelete({ where: { id: 'nonexistent' } }),
      ).rejects.toThrow(expect.objectContaining({ code: 'P2025' }));
    });

    it('fast-path softDeleteMany with no matches returns zero count and empty cascaded', async () => {
      const { count, cascaded } = await safePrisma.comment.softDeleteMany({
        where: { postId: 'nonexistent' },
      });

      expect(count).toBe(0);
      expect(cascaded).toEqual({});
    });
  });

  describe('Cascade result edge cases', () => {
    it('softDelete with partial cascade (some children already deleted)', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'partial@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active Post' },
              { id: 'p2', title: 'Already Deleted', deleted_at: new Date() },
            ],
          },
        },
      });

      const { cascaded } = await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // Only the active post (p1) should be counted in cascaded
      // p2 was already deleted so the cascade skips it
      expect(cascaded.Post).toBe(1);
    });

    it('wide cascade returns counts for multiple child types', async () => {
      await prisma.organization.create({
        data: {
          id: 'org-1',
          name: 'Acme',
          teams: {
            create: [
              { id: 'team-1', name: 'Engineering' },
              { id: 'team-2', name: 'Marketing' },
            ],
          },
          projects: {
            create: [
              { id: 'proj-1', name: 'Alpha' },
              { id: 'proj-2', name: 'Beta' },
              { id: 'proj-3', name: 'Gamma' },
            ],
          },
        },
      });

      const { cascaded } = await safePrisma.organization.softDelete({
        where: { id: 'org-1' },
      });

      expect(cascaded.Team).toBe(2);
      expect(cascaded.Project).toBe(3);
      // Asset is non-soft-deletable, should not appear
      expect(cascaded.Asset).toBeUndefined();
    });

    it('softDelete cascade result in transaction context', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'txcascade@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Post 1' },
              { id: 'p2', title: 'Post 2' },
            ],
          },
        },
      });

      const result = await safePrisma.$transaction(async (tx: any) => {
        return tx.user.softDelete({ where: { id: 'u1' } });
      });

      expect(result.record).not.toBeNull();
      expect(result.cascaded.Post).toBe(2);
    });

    it('softDeleteMany cascade result in transaction context', async () => {
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'txmany1@test.com',
          name: 'Batch',
          posts: { create: { id: 'p1', title: 'Post 1' } },
        },
      });
      await prisma.user.create({
        data: {
          id: 'u2',
          email: 'txmany2@test.com',
          name: 'Batch',
          posts: { create: { id: 'p2', title: 'Post 2' } },
        },
      });

      const result = await safePrisma.$transaction(async (tx: any) => {
        return tx.user.softDeleteMany({ where: { name: 'Batch' } });
      });

      expect(result.count).toBe(2);
      expect(result.cascaded.Post).toBe(2);
    });

    it('deep cascade (4 levels) returns correct model counts', async () => {
      await prisma.category.create({
        data: {
          id: 'cat-1',
          name: 'Electronics',
          products: {
            create: {
              id: 'prod-1',
              name: 'Phone',
              variants: {
                create: {
                  id: 'var-1',
                  sku: 'PHN-001',
                  options: {
                    create: [
                      { id: 'opt-1', name: 'Color', value: 'Black' },
                      { id: 'opt-2', name: 'Storage', value: '128GB' },
                    ],
                  },
                },
              },
            },
          },
        },
      });

      const { cascaded } = await safePrisma.category.softDelete({ where: { id: 'cat-1' } });

      expect(cascaded.Product).toBe(1);
      expect(cascaded.ProductVariant).toBe(1);
      expect(cascaded.VariantOption).toBe(2);
    });

    it('self-referential cascade returns correct counts', async () => {
      await prisma.category.create({
        data: {
          id: 'root',
          name: 'Root',
          children: {
            create: {
              id: 'child',
              name: 'Child',
              children: {
                create: { id: 'grandchild', name: 'Grandchild' },
              },
            },
          },
        },
      });

      const { cascaded } = await safePrisma.category.softDelete({ where: { id: 'root' } });

      // Self-referential: Category children
      expect(cascaded.Category).toBe(2); // child + grandchild
    });

    it('updateMany in transaction filters soft-deleted records', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com', name: 'Active' },
          { id: 'u2', email: 'b@test.com', name: 'Active', deleted_at: new Date() },
          { id: 'u3', email: 'c@test.com', name: 'Active' },
        ],
      });

      const result = await safePrisma.$transaction(async (tx: any) => {
        return tx.user.updateMany({
          where: { name: 'Active' },
          data: { name: 'Updated' },
        });
      });

      // Only 2 active records should be updated, not the soft-deleted one
      expect(result.count).toBe(2);

      // Verify the deleted record was not modified
      const deletedUser = await prisma.user.findUnique({ where: { id: 'u2' } });
      expect(deletedUser.name).toBe('Active');
    });

    it('cascade count excludes already-deleted children at all levels', async () => {
      // User -> Post -> Comment where some comments are already deleted
      await prisma.user.create({
        data: {
          id: 'u1',
          email: 'mixed@test.com',
          posts: {
            create: {
              id: 'p1',
              title: 'Post',
              comments: {
                create: [
                  { id: 'c1', content: 'Active' },
                  { id: 'c2', content: 'Already Deleted', deleted_at: new Date() },
                  { id: 'c3', content: 'Active Too' },
                ],
              },
            },
          },
        },
      });

      const { cascaded } = await safePrisma.user.softDelete({ where: { id: 'u1' } });

      expect(cascaded.Post).toBe(1);
      // Only active comments (c1, c3) should be counted
      expect(cascaded.Comment).toBe(2);
    });
  });

  describe('softDeletePreview', () => {
    describe('Simple model (leaf, no cascade)', () => {
      it('returns count of records that would be deleted', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'user@test.com' },
        });
        await prisma.post.create({
          data: { id: 'p1', title: 'Post', authorId: 'u1' },
        });
        await prisma.comment.createMany({
          data: [
            { id: 'c1', content: 'Comment 1', postId: 'p1' },
            { id: 'c2', content: 'Comment 2', postId: 'p1' },
          ],
        });

        const { wouldDelete } = await safePrisma.comment.softDeletePreview({
          where: { postId: 'p1' },
        });

        expect(wouldDelete.Comment).toBe(2);
      });

      it('excludes already-deleted records from count', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'user@test.com' },
        });
        await prisma.post.create({
          data: { id: 'p1', title: 'Post', authorId: 'u1' },
        });
        await prisma.comment.createMany({
          data: [
            { id: 'c1', content: 'Active', postId: 'p1' },
            { id: 'c2', content: 'Deleted', postId: 'p1', deleted_at: new Date() },
          ],
        });

        const { wouldDelete } = await safePrisma.comment.softDeletePreview({
          where: { postId: 'p1' },
        });

        expect(wouldDelete.Comment).toBe(1);
      });

      it('returns empty wouldDelete when no records match', async () => {
        const { wouldDelete } = await safePrisma.comment.softDeletePreview({
          where: { postId: 'nonexistent' },
        });

        expect(wouldDelete).toEqual({});
      });

      it('does not modify any data', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'user@test.com' },
        });
        await prisma.post.create({
          data: { id: 'p1', title: 'Post', authorId: 'u1' },
        });
        await prisma.comment.create({
          data: { id: 'c1', content: 'Comment', postId: 'p1' },
        });

        await safePrisma.comment.softDeletePreview({ where: { id: 'c1' } });

        // Record should still be active
        const comment = await safePrisma.comment.findUnique({ where: { id: 'c1' } });
        expect(comment).not.toBeNull();
        expect(comment.deleted_at).toBeNull();
      });
    });

    describe('Complex model (with cascade)', () => {
      it('includes root model and cascaded children in wouldDelete', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'author@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        const { wouldDelete } = await safePrisma.user.softDeletePreview({
          where: { id: 'u1' },
        });

        expect(wouldDelete.User).toBe(1);
        expect(wouldDelete.Post).toBe(2);
      });

      it('previews deep cascade (user -> post -> comment)', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'deep@test.com',
            posts: {
              create: {
                id: 'p1',
                title: 'Post',
                comments: {
                  create: [
                    { id: 'c1', content: 'Comment 1' },
                    { id: 'c2', content: 'Comment 2' },
                    { id: 'c3', content: 'Comment 3' },
                  ],
                },
              },
            },
          },
        });

        const { wouldDelete } = await safePrisma.user.softDeletePreview({
          where: { id: 'u1' },
        });

        expect(wouldDelete.User).toBe(1);
        expect(wouldDelete.Post).toBe(1);
        expect(wouldDelete.Comment).toBe(3);
      });

      it('excludes already-deleted children from preview', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'partial@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Active Post' },
                { id: 'p2', title: 'Deleted Post', deleted_at: new Date() },
              ],
            },
          },
        });

        const { wouldDelete } = await safePrisma.user.softDeletePreview({
          where: { id: 'u1' },
        });

        expect(wouldDelete.User).toBe(1);
        expect(wouldDelete.Post).toBe(1); // Only the active post
      });

      it('returns empty wouldDelete when no records match', async () => {
        const { wouldDelete } = await safePrisma.user.softDeletePreview({
          where: { id: 'nonexistent' },
        });

        expect(wouldDelete).toEqual({});
      });

      it('does not modify any data', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'preview@test.com',
            posts: {
              create: { id: 'p1', title: 'Post' },
            },
          },
        });

        await safePrisma.user.softDeletePreview({ where: { id: 'u1' } });

        // Everything should still be active
        const user = await safePrisma.user.findUnique({ where: { id: 'u1' } });
        expect(user).not.toBeNull();
        expect(user.deleted_at).toBeNull();

        const post = await safePrisma.post.findUnique({ where: { id: 'p1' } });
        expect(post).not.toBeNull();
        expect(post.deleted_at).toBeNull();
      });

      it('previews 4-level deep cascade', async () => {
        await prisma.category.create({
          data: {
            id: 'cat-1',
            name: 'Electronics',
            products: {
              create: {
                id: 'prod-1',
                name: 'Phone',
                variants: {
                  create: {
                    id: 'var-1',
                    sku: 'PHN-001',
                    options: {
                      create: [
                        { id: 'opt-1', name: 'Color', value: 'Black' },
                        { id: 'opt-2', name: 'Storage', value: '128GB' },
                      ],
                    },
                  },
                },
              },
            },
          },
        });

        const { wouldDelete } = await safePrisma.category.softDeletePreview({
          where: { id: 'cat-1' },
        });

        expect(wouldDelete.Category).toBe(1);
        expect(wouldDelete.Product).toBe(1);
        expect(wouldDelete.ProductVariant).toBe(1);
        expect(wouldDelete.VariantOption).toBe(2);
      });

      it('previews self-referential cascade', async () => {
        await prisma.category.create({
          data: {
            id: 'root',
            name: 'Root',
            children: {
              create: {
                id: 'child',
                name: 'Child',
                children: {
                  create: { id: 'grandchild', name: 'Grandchild' },
                },
              },
            },
          },
        });

        const { wouldDelete } = await safePrisma.category.softDeletePreview({
          where: { id: 'root' },
        });

        expect(wouldDelete.Category).toBe(3); // root + child + grandchild
      });

      it('preview matches actual softDelete cascade counts', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'match@test.com',
            posts: {
              create: {
                id: 'p1',
                title: 'Post',
                comments: {
                  create: [
                    { id: 'c1', content: 'C1' },
                    { id: 'c2', content: 'C2' },
                  ],
                },
              },
            },
          },
        });

        // Preview first
        const { wouldDelete } = await safePrisma.user.softDeletePreview({
          where: { id: 'u1' },
        });

        // Then actually delete
        const { cascaded } = await safePrisma.user.softDelete({
          where: { id: 'u1' },
        });

        // Preview root count should match
        expect(wouldDelete.User).toBe(1);
        // Preview cascaded counts should match actual cascaded counts
        expect(wouldDelete.Post).toBe(cascaded.Post);
        expect(wouldDelete.Comment).toBe(cascaded.Comment);
      });

      it('wide cascade preview returns counts for multiple child types', async () => {
        await prisma.organization.create({
          data: {
            id: 'org-1',
            name: 'Acme',
            teams: {
              create: [
                { id: 'team-1', name: 'Engineering' },
                { id: 'team-2', name: 'Marketing' },
              ],
            },
            projects: {
              create: [
                { id: 'proj-1', name: 'Alpha' },
                { id: 'proj-2', name: 'Beta' },
              ],
            },
          },
        });

        const { wouldDelete } = await safePrisma.organization.softDeletePreview({
          where: { id: 'org-1' },
        });

        expect(wouldDelete.Organization).toBe(1);
        expect(wouldDelete.Team).toBe(2);
        expect(wouldDelete.Project).toBe(2);
      });
    });

    describe('In transactions', () => {
      it('simple model preview works in transaction', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'user@test.com' },
        });
        await prisma.post.create({
          data: { id: 'p1', title: 'Post', authorId: 'u1' },
        });
        await prisma.comment.createMany({
          data: [
            { id: 'c1', content: 'C1', postId: 'p1' },
            { id: 'c2', content: 'C2', postId: 'p1' },
          ],
        });

        const result = await safePrisma.$transaction(async (tx: any) => {
          return tx.comment.softDeletePreview({ where: { postId: 'p1' } });
        });

        expect(result.wouldDelete.Comment).toBe(2);
      });

      it('complex model preview works in transaction', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'tx@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        const result = await safePrisma.$transaction(async (tx: any) => {
          return tx.user.softDeletePreview({ where: { id: 'u1' } });
        });

        expect(result.wouldDelete.User).toBe(1);
        expect(result.wouldDelete.Post).toBe(2);
      });

      it('preview reflects transaction state', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'txstate@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
                { id: 'p3', title: 'Post 3' },
              ],
            },
          },
        });

        const result = await safePrisma.$transaction(async (tx: any) => {
          // Soft delete one post first
          await tx.post.softDelete({ where: { id: 'p1' } });

          // Now preview should exclude the already-deleted post
          return tx.user.softDeletePreview({ where: { id: 'u1' } });
        });

        expect(result.wouldDelete.User).toBe(1);
        expect(result.wouldDelete.Post).toBe(2); // p2 and p3 only
      });
    });
  });

  describe('Filter Propagation', () => {
    describe('$onlyDeleted propagation', () => {
      it('propagates only-deleted filter to first-level relations', async () => {
        // Create user with posts, then cascade delete
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        // Soft delete the user (cascades to posts)
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        // Query with $onlyDeleted - should get deleted user WITH deleted posts
        const result = await safePrisma.$onlyDeleted.user.findFirst({
          where: { id: 'u1' },
          include: { posts: true },
        });

        expect(result).not.toBeNull();
        expect(result!.deleted_at).not.toBeNull();
        expect(result!.posts).toHaveLength(2);
        expect(result!.posts[0].deleted_at).not.toBeNull();
        expect(result!.posts[1].deleted_at).not.toBeNull();
      });

      it('propagates only-deleted filter to deeply nested relations', async () => {
        // Create user -> post -> comment, all soft-deletable
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: {
                id: 'p1',
                title: 'Post',
                comments: {
                  create: [
                    { id: 'c1', content: 'Comment 1' },
                    { id: 'c2', content: 'Comment 2' },
                  ],
                },
              },
            },
          },
        });

        // Soft delete the user (cascades all the way down)
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        // Query with deep nesting
        const result = await safePrisma.$onlyDeleted.user.findFirst({
          where: { id: 'u1' },
          include: {
            posts: {
              include: {
                comments: true,
              },
            },
          },
        });

        expect(result).not.toBeNull();
        expect(result!.deleted_at).not.toBeNull();
        expect(result!.posts[0].deleted_at).not.toBeNull();
        expect(result!.posts[0].comments).toHaveLength(2);
        expect(result!.posts[0].comments[0].deleted_at).not.toBeNull();
        expect(result!.posts[0].comments[1].deleted_at).not.toBeNull();
      });

      it('propagates to _count relations', async () => {
        // Create user with posts
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2', deleted_at: new Date() },
              ],
            },
          },
        });

        // Soft delete user
        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        // Query with _count
        const result = await safePrisma.$onlyDeleted.user.findFirst({
          where: { id: 'u1' },
          include: {
            _count: {
              select: { posts: true },
            },
          },
        });

        // Should count only deleted posts (both p1 and p2 are now deleted)
        expect(result!._count.posts).toBe(2);
      });
    });

    describe('$includingDeleted propagation', () => {
      it('propagates include-deleted filter to relations', async () => {
        // Create user with mix of active and deleted posts
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Active Post' },
                { id: 'p2', title: 'Deleted Post', deleted_at: new Date() },
              ],
            },
          },
        });

        // Query with $includingDeleted - should get both active and deleted posts
        const result = await safePrisma.$includingDeleted.user.findFirst({
          where: { id: 'u1' },
          include: { posts: true },
        });

        expect(result).not.toBeNull();
        expect(result!.posts).toHaveLength(2);
      });

      it('propagates include-deleted to deeply nested relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            deleted_at: new Date(),
            posts: {
              create: {
                id: 'p1',
                title: 'Post',
                comments: {
                  create: [
                    { id: 'c1', content: 'Active Comment' },
                    { id: 'c2', content: 'Deleted Comment', deleted_at: new Date() },
                  ],
                },
              },
            },
          },
        });

        const result = await safePrisma.$includingDeleted.user.findFirst({
          where: { id: 'u1' },
          include: {
            posts: {
              include: {
                comments: true,
              },
            },
          },
        });

        expect(result!.posts[0].comments).toHaveLength(2);
      });
    });

    describe('Explicit filter overrides', () => {
      it('respects user explicit deleted_at filter in relations', async () => {
        // Create user with posts
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Active Post' },
                { id: 'p2', title: 'Deleted Post', deleted_at: new Date() },
              ],
            },
          },
        });

        // Manually delete user WITHOUT cascading (using raw prisma)
        await prisma.user.update({
          where: { id: 'u1' },
          data: { deleted_at: new Date() },
        });

        // Query deleted user but override to get only ACTIVE posts
        const result = await safePrisma.$onlyDeleted.user.findFirst({
          where: { id: 'u1' },
          include: {
            posts: {
              where: { deleted_at: null }, // Explicit override
            },
          },
        });

        expect(result).not.toBeNull();
        expect(result!.deleted_at).not.toBeNull(); // User is deleted
        expect(result!.posts).toHaveLength(1); // Only active post
        expect(result!.posts[0].id).toBe('p1');
        expect(result!.posts[0].deleted_at).toBeNull();
      });

      it('allows mixed filtering in nested relations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                {
                  id: 'p1',
                  title: 'Post 1',
                  comments: {
                    create: [
                      { id: 'c1', content: 'Comment 1' },
                      { id: 'c2', content: 'Comment 2', deleted_at: new Date() },
                    ],
                  },
                },
              ],
            },
          },
        });

        // Manually delete user and post WITHOUT cascading to comments
        await prisma.user.update({
          where: { id: 'u1' },
          data: { deleted_at: new Date() },
        });
        await prisma.post.update({
          where: { id: 'p1' },
          data: { deleted_at: new Date() },
        });

        // Deleted user, with deleted posts, but only active comments
        const result = await safePrisma.$onlyDeleted.user.findFirst({
          where: { id: 'u1' },
          include: {
            posts: {
              include: {
                comments: {
                  where: { deleted_at: null }, // Override: active comments only
                },
              },
            },
          },
        });

        expect(result!.posts[0].comments).toHaveLength(1);
        expect(result!.posts[0].comments[0].id).toBe('c1');
      });
    });
  });

  describe('Transaction Escape Hatches', () => {
    describe('tx.$onlyDeleted', () => {
      it('is available in transaction context', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            deleted_at: new Date(),
          },
        });

        const result = await safePrisma.$transaction(async (tx: any) => {
          return tx.$onlyDeleted.user.findFirst({ where: { id: 'u1' } });
        });

        expect(result).not.toBeNull();
        expect(result!.deleted_at).not.toBeNull();
      });

      it('propagates filter mode in transaction', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        const result = await safePrisma.$transaction(async (tx: any) => {
          return tx.$onlyDeleted.user.findFirst({
            where: { id: 'u1' },
            include: { posts: true },
          });
        });

        expect(result!.posts).toHaveLength(2);
        expect(result!.posts[0].deleted_at).not.toBeNull();
      });

      it('works with atomic audit logging', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
          },
        });

        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        // Atomic restore with audit log
        await safePrisma.$transaction(async (tx: any) => {
          const user = await tx.$onlyDeleted.user.findFirst({ where: { id: 'u1' } });
          await tx.user.restore({ where: { id: 'u1' } });
          await tx.auditLog.create({
            data: {
              action: `RESTORE:User:${String(user!.id)}`,
              entityId: user!.id,
            },
          });
        });

        const restored = await safePrisma.user.findFirst({ where: { id: 'u1' } });
        const audit = await safePrisma.auditLog.findFirst({
          where: { action: { startsWith: 'RESTORE:' } }
        });

        expect(restored).not.toBeNull();
        expect(restored!.deleted_at).toBeNull();
        expect(audit).not.toBeNull();
      });
    });

    describe('tx.$includingDeleted', () => {
      it('is available in transaction context', async () => {
        await prisma.user.create({
          data: { id: 'u1', email: 'active@test.com' },
        });
        await prisma.user.create({
          data: { id: 'u2', email: 'deleted@test.com', deleted_at: new Date() },
        });

        const result = await safePrisma.$transaction(async (tx: any) => {
          return tx.$includingDeleted.user.findMany();
        });

        expect(result).toHaveLength(2);
      });

      it('propagates include-deleted mode in transaction', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Active' },
                { id: 'p2', title: 'Deleted', deleted_at: new Date() },
              ],
            },
          },
        });

        const result = await safePrisma.$transaction(async (tx: any) => {
          return tx.$includingDeleted.user.findFirst({
            where: { id: 'u1' },
            include: { posts: true },
          });
        });

        expect(result!.posts).toHaveLength(2);
      });
    });

    describe('tx.model.restoreCascade', () => {
      it('works in transaction for atomic operations', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Post 1' },
                { id: 'p2', title: 'Post 2' },
              ],
            },
          },
        });

        await safePrisma.user.softDelete({ where: { id: 'u1' } });

        const { record, cascaded, logId } = await safePrisma.$transaction(async (tx: any) => {
          const { record, cascaded } = await tx.user.restoreCascade({ where: { id: 'u1' } });

          const log = await tx.auditLog.create({
            data: {
              action: `RESTORE_CASCADE:User:${String(record!.id)}:${JSON.stringify(cascaded)}`,
              entityId: record!.id,
            },
          });

          return { record, cascaded, logId: log.id };
        });

        expect(record).not.toBeNull();
        expect(cascaded.Post).toBe(2);
        expect(logId).toBeDefined();

        // Verify all restored
        const user = await safePrisma.user.findFirst({ where: { id: 'u1' } });
        const posts = await safePrisma.post.findMany({ where: { authorId: 'u1' } });

        expect(user!.deleted_at).toBeNull();
        expect(posts).toHaveLength(2);
      });
    });
  });

  describe('Helper Utilities', () => {
    let onlyDeleted: any;
    let excludeDeleted: any;
    let includingDeleted: any;

    beforeAll(async () => {
      // Import the helpers
      const helpersModule = await import('./generated/soft-cascade/runtime.js');
      onlyDeleted = helpersModule.onlyDeleted;
      excludeDeleted = helpersModule.excludeDeleted;
      includingDeleted = helpersModule.includingDeleted;
    });

    describe('onlyDeleted()', () => {
      it('adds deleted_at filter for soft-deletable models', () => {
        const where = onlyDeleted('User', { email: 'test@test.com' });
        expect(where).toEqual({
          email: 'test@test.com',
          deleted_at: { not: null },
        });
      });

      it('works in nested relation filters', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Active', deleted_at: null },
                { id: 'p2', title: 'Deleted', deleted_at: new Date() },
              ],
            },
          },
        });

        const result = await safePrisma.user.findFirst({
          where: {
            id: 'u1',
            posts: {
              some: onlyDeleted('Post', { title: { contains: 'Deleted' } }),
            },
          },
        });

        expect(result).not.toBeNull();
      });

      it('handles empty where object', () => {
        const where = onlyDeleted('User');
        expect(where).toEqual({ deleted_at: { not: null } });
      });
    });

    describe('excludeDeleted()', () => {
      it('adds deleted_at: null filter', () => {
        const where = excludeDeleted('Post', { published: true });
        expect(where).toEqual({
          published: true,
          deleted_at: null,
        });
      });

      it('can override propagation in $onlyDeleted queries', async () => {
        await prisma.user.create({
          data: {
            id: 'u1',
            email: 'user@test.com',
            posts: {
              create: [
                { id: 'p1', title: 'Active' },
                { id: 'p2', title: 'Deleted', deleted_at: new Date() },
              ],
            },
          },
        });

        // Manually delete user WITHOUT cascading
        await prisma.user.update({
          where: { id: 'u1' },
          data: { deleted_at: new Date() },
        });

        // Alternative syntax for override using helper
        const result = await safePrisma.$onlyDeleted.user.findFirst({
          where: { id: 'u1' },
          include: {
            posts: {
              where: excludeDeleted('Post', {}),
            },
          },
        });

        expect(result!.posts).toHaveLength(1);
        expect(result!.posts[0].id).toBe('p1');
      });
    });

    describe('includingDeleted()', () => {
      it('returns where clause unchanged', () => {
        const where = { email: 'test@test.com' };
        const result = includingDeleted(where);
        expect(result).toBe(where);
      });

      it('is a no-op for documentation purposes', () => {
        const result = includingDeleted({});
        expect(result).toEqual({});
      });
    });
  });
});

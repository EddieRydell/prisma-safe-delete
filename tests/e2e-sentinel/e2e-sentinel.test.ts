import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = __dirname;

const SENTINEL_DATE = new Date('9999-12-31T00:00:00.000Z');

let PrismaClient: any;
let wrapPrismaClient: any;
let prisma: any;
let safePrisma: any;
let pool: pg.Pool | undefined;

function getConnectionString(): string {
  if (process.env.DATABASE_URL_SENTINEL !== undefined) return process.env.DATABASE_URL_SENTINEL;
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL.replace(/\/[^/]+$/, '/test_sentinel');
  return 'postgresql://postgres:postgres@localhost:5433/test_sentinel';
}

describe('E2E Sentinel: Real database tests', () => {
  beforeAll(async () => {
    // Ensure database exists
    const baseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres';
    const adminPool = new pg.Pool({ connectionString: baseUrl });
    try {
      await adminPool.query('CREATE DATABASE test_sentinel');
    } catch {
      // Already exists
    }
    await adminPool.end();

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
    execSync('npx prisma db push --force-reset', {
      cwd: e2eDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes',
      },
    });

    // Dynamically import the generated modules
    const clientModule = await import('./generated/client/client.js');
    PrismaClient = clientModule.PrismaClient;

    const softCascadeModule = await import('./generated/soft-cascade/runtime.js');
    wrapPrismaClient = softCascadeModule.wrapPrismaClient;

    // Create pg pool and Prisma adapter
    const connectionString = getConnectionString();
    pool = new pg.Pool({ connectionString });
    const adapter = new PrismaPg(pool);

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
    await prisma.comment.deleteMany();
    await prisma.post.deleteMany();
    await prisma.user.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.auditLog.deleteMany();
  });

  describe('create operations', () => {
    it('create auto-injects sentinel value for deleted_at', async () => {
      const user = await safePrisma.user.create({
        data: { email: 'test@test.com', name: 'Test' },
      });

      expect(user.deleted_at).toEqual(SENTINEL_DATE);
    });

    it('createMany injects sentinel value', async () => {
      await safePrisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com' },
          { id: 'u2', email: 'b@test.com' },
        ],
      });

      const users = await prisma.user.findMany();
      for (const user of users) {
        expect(user.deleted_at).toEqual(SENTINEL_DATE);
      }
    });

    it('createManyAndReturn injects sentinel value', async () => {
      const users = await safePrisma.user.createManyAndReturn({
        data: [
          { id: 'u1', email: 'a@test.com' },
          { id: 'u2', email: 'b@test.com' },
        ],
      });

      for (const user of users) {
        expect(user.deleted_at).toEqual(SENTINEL_DATE);
      }
    });
  });

  describe('read operations', () => {
    it('findMany filters by sentinel comparison', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'active@test.com' } });
      // Soft-delete a user (sets real timestamp)
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'active2@test.com' } });

      const users = await safePrisma.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('u2');
    });

    it('count filters by sentinel comparison', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'a@test.com' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'b@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const count = await safePrisma.user.count();
      expect(count).toBe(1);
    });

    it('findUnique transforms to compound key for sentinel', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'find@test.com' } });

      // findUnique with just email should work (transformed to compound key)
      const user = await safePrisma.user.findUnique({
        where: { email_deleted_at: { email: 'find@test.com', deleted_at: SENTINEL_DATE } },
      });
      expect(user).not.toBeNull();
      expect(user.id).toBe('u1');
    });
  });

  describe('soft delete operations', () => {
    it('softDelete sets real timestamp overwriting sentinel', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'del@test.com' } });

      const before = new Date();
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      const after = new Date();

      const raw = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(raw.deleted_at).not.toEqual(SENTINEL_DATE);
      expect(raw.deleted_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(raw.deleted_at.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('restore sets sentinel back', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'restore@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      await safePrisma.user.restore({ where: { id: 'u1' } });

      const raw = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(raw.deleted_at).toEqual(SENTINEL_DATE);
    });
  });

  describe('cascade operations', () => {
    it('cascade: parent + children all get same timestamp', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'cascade@test.com',
          posts: {
            create: [
              {
                id: 'p1',
                title: 'Post 1',
                comments: {
                  create: [{ id: 'c1', content: 'Comment 1' }],
                },
              },
            ],
          },
        },
      });

      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      const post = await prisma.post.findUnique({ where: { id: 'p1' } });
      const comment = await prisma.comment.findUnique({ where: { id: 'c1' } });

      // All should have the same real timestamp (not sentinel)
      expect(user.deleted_at).not.toEqual(SENTINEL_DATE);
      expect(post.deleted_at).toEqual(user.deleted_at);
      expect(comment.deleted_at).toEqual(user.deleted_at);
    });
  });

  describe('upsert operations', () => {
    it('upsert create branch gets sentinel value', async () => {
      const result = await safePrisma.user.upsert({
        where: { email_deleted_at: { email: 'upsert@test.com', deleted_at: SENTINEL_DATE } },
        create: { email: 'upsert@test.com', name: 'Created' },
        update: { name: 'Updated' },
      });

      expect(result.name).toBe('Created');
      expect(result.deleted_at).toEqual(SENTINEL_DATE);
    });

    it('upsert update branch works for active records', async () => {
      await safePrisma.user.create({
        data: { id: 'u1', email: 'upsert@test.com', name: 'Original' },
      });

      const result = await safePrisma.user.upsert({
        where: { email_deleted_at: { email: 'upsert@test.com', deleted_at: SENTINEL_DATE } },
        create: { email: 'upsert@test.com', name: 'Should Not Create' },
        update: { name: 'Updated' },
      });

      expect(result.id).toBe('u1');
      expect(result.name).toBe('Updated');
    });
  });

  describe('compound unique enforcement', () => {
    it('duplicate active email fails at DB level', async () => {
      await safePrisma.user.create({ data: { email: 'dup@test.com' } });

      await expect(
        safePrisma.user.create({ data: { email: 'dup@test.com' } }),
      ).rejects.toThrow();
    });

    it('same email can exist as active + deleted', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'reuse@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // Creating with same email should succeed (deleted_at is different now)
      const newUser = await safePrisma.user.create({
        data: { id: 'u2', email: 'reuse@test.com' },
      });
      expect(newUser.id).toBe('u2');
    });
  });

  describe('$onlyDeleted and $includingDeleted', () => {
    it('$onlyDeleted uses sentinel comparison', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'a@test.com' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'b@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const deletedUsers = await safePrisma.$onlyDeleted.user.findMany();
      expect(deletedUsers).toHaveLength(1);
      expect(deletedUsers[0].id).toBe('u1');
    });

    it('$includingDeleted returns all records', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'a@test.com' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'b@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const allUsers = await safePrisma.$includingDeleted.user.findMany();
      expect(allUsers).toHaveLength(2);
    });
  });

  describe('deleted_by propagation', () => {
    it('deleted_by works with sentinel strategy', async () => {
      await safePrisma.customer.create({
        data: { id: 'c1', email: 'customer@test.com' },
      });

      await safePrisma.customer.softDelete({
        where: { id: 'c1' },
        deletedBy: 'admin-user',
      });

      const raw = await prisma.customer.findUnique({ where: { id: 'c1' } });
      expect(raw.deleted_by).toBe('admin-user');
      expect(raw.deleted_at).not.toEqual(SENTINEL_DATE);
    });
  });

  describe('filter injection on includes', () => {
    it('include filters soft-deleted children with sentinel', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'parent@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active Post' },
              { id: 'p2', title: 'To Delete Post' },
            ],
          },
        },
      });

      await safePrisma.post.softDelete({ where: { id: 'p2' } });

      const user = await safePrisma.user.findFirst({
        where: { id: 'u1' },
        include: { posts: true },
      });

      expect(user.posts).toHaveLength(1);
      expect(user.posts[0].id).toBe('p1');
    });
  });

  describe('sentinel cascade soft-delete', () => {
    it('cascade sets real timestamp (not sentinel) on parent, posts, and comments', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'cascade-sentinel@test.com',
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
              {
                id: 'p2',
                title: 'Post 2',
                comments: {
                  create: [{ id: 'c3', content: 'Comment 3' }],
                },
              },
            ],
          },
        },
      });

      // Verify all records start with sentinel value
      const userBefore = await prisma.user.findUnique({ where: { id: 'u1' } });
      const postBefore = await prisma.post.findUnique({ where: { id: 'p1' } });
      const commentBefore = await prisma.comment.findUnique({ where: { id: 'c1' } });
      expect(userBefore.deleted_at).toEqual(SENTINEL_DATE);
      expect(postBefore.deleted_at).toEqual(SENTINEL_DATE);
      expect(commentBefore.deleted_at).toEqual(SENTINEL_DATE);

      const before = new Date();
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      const after = new Date();

      // Check all records via raw prisma (bypassing filters)
      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      const post1 = await prisma.post.findUnique({ where: { id: 'p1' } });
      const post2 = await prisma.post.findUnique({ where: { id: 'p2' } });
      const comment1 = await prisma.comment.findUnique({ where: { id: 'c1' } });
      const comment2 = await prisma.comment.findUnique({ where: { id: 'c2' } });
      const comment3 = await prisma.comment.findUnique({ where: { id: 'c3' } });

      // All should have a real timestamp, NOT the sentinel
      for (const record of [user, post1, post2, comment1, comment2, comment3]) {
        expect(record.deleted_at).not.toEqual(SENTINEL_DATE);
        expect(record.deleted_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(record.deleted_at.getTime()).toBeLessThanOrEqual(after.getTime());
      }

      // All should share the same cascade timestamp
      expect(post1.deleted_at).toEqual(user.deleted_at);
      expect(post2.deleted_at).toEqual(user.deleted_at);
      expect(comment1.deleted_at).toEqual(user.deleted_at);
      expect(comment2.deleted_at).toEqual(user.deleted_at);
      expect(comment3.deleted_at).toEqual(user.deleted_at);

      // Excluded from normal findMany
      const activeUsers = await safePrisma.user.findMany();
      const activePosts = await safePrisma.post.findMany();
      const activeComments = await safePrisma.comment.findMany();
      expect(activeUsers).toHaveLength(0);
      expect(activePosts).toHaveLength(0);
      expect(activeComments).toHaveLength(0);

      // Visible via $onlyDeleted
      const deletedUsers = await safePrisma.$onlyDeleted.user.findMany();
      const deletedPosts = await safePrisma.$onlyDeleted.post.findMany();
      const deletedComments = await safePrisma.$onlyDeleted.comment.findMany();
      expect(deletedUsers).toHaveLength(1);
      expect(deletedUsers[0].id).toBe('u1');
      expect(deletedPosts).toHaveLength(2);
      expect(deletedComments).toHaveLength(3);
    });
  });

  describe('sentinel restoreCascade', () => {
    it('restoreCascade restores sentinel value on parent and all cascaded children', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'restore-cascade@test.com',
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

      // Cascade soft-delete
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // Verify all deleted (real timestamp, not sentinel)
      const deletedUser = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(deletedUser.deleted_at).not.toEqual(SENTINEL_DATE);

      // Restore with cascade
      const { record: restored, cascaded } = await safePrisma.user.restoreCascade({ where: { id: 'u1' } });
      expect(restored).not.toBeNull();
      expect(restored.deleted_at).toEqual(SENTINEL_DATE);

      // Verify cascade counts
      expect(cascaded.Post).toBe(2);
      expect(cascaded.Comment).toBe(2);

      // All records should have sentinel value restored via raw prisma
      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      const post1 = await prisma.post.findUnique({ where: { id: 'p1' } });
      const post2 = await prisma.post.findUnique({ where: { id: 'p2' } });
      const comment1 = await prisma.comment.findUnique({ where: { id: 'c1' } });
      const comment2 = await prisma.comment.findUnique({ where: { id: 'c2' } });

      expect(user.deleted_at).toEqual(SENTINEL_DATE);
      expect(post1.deleted_at).toEqual(SENTINEL_DATE);
      expect(post2.deleted_at).toEqual(SENTINEL_DATE);
      expect(comment1.deleted_at).toEqual(SENTINEL_DATE);
      expect(comment2.deleted_at).toEqual(SENTINEL_DATE);

      // All should appear in normal findMany again
      const activeUsers = await safePrisma.user.findMany();
      const activePosts = await safePrisma.post.findMany();
      const activeComments = await safePrisma.comment.findMany();
      expect(activeUsers).toHaveLength(1);
      expect(activePosts).toHaveLength(2);
      expect(activeComments).toHaveLength(2);
    });

    it('restoreCascade only restores children with matching timestamp', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'partial-restore@test.com',
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

      // Wait to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Soft delete user (cascades to post 2, but post 1 already has different timestamp)
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // Restore user with cascade
      await safePrisma.user.restoreCascade({ where: { id: 'u1' } });

      // Post 2 should be restored (same timestamp as user)
      const post2 = await safePrisma.post.findUnique({ where: { id: 'p2' } });
      expect(post2).not.toBeNull();
      expect(post2.deleted_at).toEqual(SENTINEL_DATE);

      // Post 1 should still be deleted (different timestamp from independent delete)
      const post1 = await prisma.post.findUnique({ where: { id: 'p1' } });
      expect(post1.deleted_at?.getTime()).toBe(independentTimestamp?.getTime());
      expect(post1.deleted_at).not.toEqual(SENTINEL_DATE);
    });
  });

  describe('sentinel _count filtering', () => {
    it('_count in include filters out soft-deleted posts', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'count@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active 1' },
              { id: 'p2', title: 'Active 2' },
              { id: 'p3', title: 'To Delete' },
            ],
          },
        },
      });

      // Soft-delete one post
      await safePrisma.post.softDelete({ where: { id: 'p3' } });

      const user = await safePrisma.user.findFirst({
        where: { id: 'u1' },
        include: { _count: { select: { posts: true } } },
      });

      // Should count only active posts (sentinel value), not the soft-deleted one
      expect(user._count.posts).toBe(2);
    });

    it('_count: true in include filters out soft-deleted posts', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'count-true@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active' },
              { id: 'p2', title: 'To Delete 1' },
              { id: 'p3', title: 'To Delete 2' },
            ],
          },
        },
      });

      await safePrisma.post.softDelete({ where: { id: 'p2' } });
      await safePrisma.post.softDelete({ where: { id: 'p3' } });

      const user = await safePrisma.user.findFirst({
        where: { id: 'u1' },
        include: { _count: true },
      });

      expect(user._count.posts).toBe(1);
    });

    it('_count in select filters out soft-deleted posts', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'count-select@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active 1' },
              { id: 'p2', title: 'Active 2' },
              { id: 'p3', title: 'Active 3' },
              { id: 'p4', title: 'To Delete' },
            ],
          },
        },
      });

      await safePrisma.post.softDelete({ where: { id: 'p4' } });

      const user = await safePrisma.user.findFirst({
        where: { id: 'u1' },
        select: { email: true, _count: { select: { posts: true } } },
      });

      expect(user._count.posts).toBe(3);
      expect(user.email).toBe('count-select@test.com');
    });
  });
});

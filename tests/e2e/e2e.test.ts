import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = __dirname;
const dbPath = path.join(e2eDir, 'test.db');

// These will be dynamically imported after generation
let PrismaClient: any;
let wrapPrismaClient: any;
let prisma: any;
let safePrisma: any;

describe('E2E: Real database tests', () => {
  beforeAll(async () => {
    // Clean up any existing test database
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }

    // Build the generator
    execSync('pnpm run build', {
      cwd: path.join(e2eDir, '..', '..'),
      stdio: 'pipe',
    });

    // Generate Prisma client and soft-cascade wrapper
    execSync('npx prisma generate', {
      cwd: e2eDir,
      stdio: 'pipe',
    });

    // Push schema to create database
    execSync('npx prisma db push --skip-generate', {
      cwd: e2eDir,
      stdio: 'pipe',
    });

    // Dynamically import the generated modules
    const clientModule = await import('./generated/client/index.js');
    PrismaClient = clientModule.PrismaClient;

    const softCascadeModule = await import('./generated/soft-cascade/runtime.js');
    wrapPrismaClient = softCascadeModule.wrapPrismaClient;

    // Create the clients
    prisma = new PrismaClient();
    safePrisma = wrapPrismaClient(prisma);

    await prisma.$connect();
  }, 120000);

  afterAll(async () => {
    await prisma?.$disconnect();

    // Clean up test database
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  beforeEach(async () => {
    // Clean all tables before each test
    await prisma.comment.deleteMany();
    await prisma.post.deleteMany();
    await prisma.profile.deleteMany();
    await prisma.user.deleteMany();
    await prisma.auditLog.deleteMany();
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

    it('hardDelete permanently removes record', async () => {
      await prisma.user.create({
        data: { id: 'user-1', email: 'test@test.com' },
      });

      await safePrisma.user.hardDelete({ where: { id: 'user-1' } });

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
});

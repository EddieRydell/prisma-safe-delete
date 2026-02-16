import 'dotenv/config';
import { defineConfig } from 'prisma/config';

function getUrl(): string {
  if (process.env.DATABASE_URL_NO_CASCADE !== undefined) return process.env.DATABASE_URL_NO_CASCADE;
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL.replace(/\/[^/]+$/, '/test_no_cascade');
  return 'postgresql://postgres:postgres@localhost:5433/test_no_cascade';
}

export default defineConfig({
  schema: './schema.prisma',
  datasource: {
    url: getUrl(),
  },
});

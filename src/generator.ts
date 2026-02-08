import generatorHelper from '@prisma/generator-helper';
const { generatorHandler } = generatorHelper;
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseDMMF,
  type ParsedSchema,
  type UniqueConstraintInfo,
} from './dmmf-parser.js';
import { buildCascadeGraph } from './cascade-graph.js';
import {
  emitTypes,
  emitRuntime,
  emitCascadeGraph,
  emitIndex,
} from './codegen/index.js';

/**
 * Strategy for handling unique constraints on soft delete.
 * - 'mangle': Append "__deleted_{pk}" suffix to unique string fields (default)
 * - 'none': Skip mangling; use this if you set up partial unique indexes yourself
 */
export type UniqueStrategy = 'mangle' | 'none';

/**
 * ANSI color codes for terminal output
 */
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

/**
 * Model info for unique strategy warning
 */
export interface UniqueFieldInfo {
  model: string;
  deletedAtField: string;
  /** Standalone @unique fields and compound @@unique NOT including deleted_at */
  constraintsNeedingIndexes: UniqueConstraintInfo[];
  /** Compound @@unique constraints that include deleted_at (broken pattern) */
  compoundWithDeletedAt: UniqueConstraintInfo[];
}

/**
 * Collects models that have unique constraints requiring attention.
 * Categorizes constraints into those needing partial indexes and those
 * with the broken @@unique([..., deleted_at]) pattern.
 * Exported for testing.
 */
export function collectModelsWithUniqueFields(schema: ParsedSchema): UniqueFieldInfo[] {
  const result: UniqueFieldInfo[] = [];

  for (const model of schema.models) {
    if (!model.isSoftDeletable || model.deletedAtField === null) {
      continue;
    }

    const constraintsNeedingIndexes: UniqueConstraintInfo[] = [];
    const compoundWithDeletedAt: UniqueConstraintInfo[] = [];

    for (const constraint of model.uniqueConstraints) {
      if (constraint.includesDeletedAt) {
        compoundWithDeletedAt.push(constraint);
      } else {
        constraintsNeedingIndexes.push(constraint);
      }
    }

    if (constraintsNeedingIndexes.length > 0 || compoundWithDeletedAt.length > 0) {
      result.push({
        model: model.name,
        deletedAtField: model.deletedAtField,
        constraintsNeedingIndexes,
        compoundWithDeletedAt,
      });
    }
  }

  return result;
}

/**
 * Builds the warning message lines (without ANSI colors for testing).
 * Exported for testing.
 */
export function buildUniqueStrategyWarningLines(
  modelsWithUniqueFields: UniqueFieldInfo[],
  useColors = true,
): string[] {
  if (modelsWithUniqueFields.length === 0) {
    return [];
  }

  const y = useColors ? YELLOW : '';
  const cn = useColors ? CYAN : '';
  const r = useColors ? RESET : '';
  const b = useColors ? BOLD : '';

  const lines: string[] = [
    '',
    `${y}${b}⚠️  prisma-safe-delete: uniqueStrategy is 'none'${r}`,
    `${y}   You must create partial unique indexes manually to prevent conflicts.${r}`,
  ];

  // Section 1: Compound @@unique constraints that include deleted_at
  const allCompoundWithDeletedAt = modelsWithUniqueFields.flatMap((info) =>
    info.compoundWithDeletedAt.map((constraint) => ({
      model: info.model,
      deletedAtField: info.deletedAtField,
      constraint,
    })),
  );

  if (allCompoundWithDeletedAt.length > 0) {
    lines.push('');
    lines.push(
      `${y}${b}   ⚠️  Compound @@unique constraints including deleted_at detected:${r}`,
    );
    lines.push(
      `${y}   These do NOT enforce uniqueness on active records because NULL != NULL in SQL.${r}`,
    );
    lines.push(
      `${y}   Multiple active records (where deleted_at IS NULL) can have the same values.${r}`,
    );
    lines.push('');
    lines.push(`${cn}   Replace with partial unique indexes:${r}`);

    for (const { model, deletedAtField, constraint } of allCompoundWithDeletedAt) {
      const fieldList = constraint.fields.join(', ');
      const indexName = `${model.toLowerCase()}_${constraint.fields.join('_')}_active`;
      lines.push(
        `     CREATE UNIQUE INDEX ${indexName} ON "${model}"(${fieldList}) WHERE ${deletedAtField} IS NULL;`,
      );
    }

    lines.push('');
    lines.push(
      `${cn}   Alternative: Use NULLS NOT DISTINCT (PostgreSQL 15+) on the existing constraint.${r}`,
    );
  }

  // Section 2: Constraints needing partial indexes (standalone @unique and compound @@unique without deleted_at)
  const allConstraintsNeedingIndexes = modelsWithUniqueFields.flatMap((info) =>
    info.constraintsNeedingIndexes.map((constraint) => ({
      model: info.model,
      deletedAtField: info.deletedAtField,
      constraint,
    })),
  );

  if (allConstraintsNeedingIndexes.length > 0) {
    lines.push('');
    lines.push(`${cn}   Models requiring partial unique indexes:${r}`);

    for (const info of modelsWithUniqueFields) {
      if (info.constraintsNeedingIndexes.length === 0) continue;
      const fieldDescriptions = info.constraintsNeedingIndexes.map((constraint) =>
        constraint.fields.length > 1
          ? `(${constraint.fields.join(', ')})`
          : constraint.fields[0],
      );
      lines.push(`     - ${info.model}: ${fieldDescriptions.join(', ')}`);
    }

    lines.push('');
    lines.push(`${cn}   Example SQL (PostgreSQL):${r}`);

    for (const { model, deletedAtField, constraint } of allConstraintsNeedingIndexes) {
      const fieldList = constraint.fields.join(', ');
      const indexName = `${model.toLowerCase()}_${constraint.fields.join('_')}_active`;
      lines.push(
        `     CREATE UNIQUE INDEX ${indexName} ON "${model}"(${fieldList}) WHERE ${deletedAtField} IS NULL;`,
      );
    }
  }

  lines.push('');
  lines.push(
    `${y}   Without these indexes, soft-deleted records will block new records with the same unique values.${r}`,
  );
  lines.push('');

  return lines;
}

/**
 * Emits a warning when uniqueStrategy is 'none' to remind users to create partial indexes.
 */
function emitUniqueStrategyWarning(schema: ParsedSchema): void {
  const modelsWithUniqueFields = collectModelsWithUniqueFields(schema);
  const lines = buildUniqueStrategyWarningLines(modelsWithUniqueFields);

  if (lines.length > 0) {
    // Print warning to console
    // Using console.log because Prisma may suppress stderr
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }
}

/**
 * Computes the relative import path from our output directory to the Prisma client.
 * Returns a path like '../client/client.js' for ESM compatibility with NodeNext module resolution.
 */
function computeClientImportPath(
  ourOutputDir: string,
  clientOutputDir: string,
): string {
  // Calculate relative path from our output to client output
  let relativePath = path.relative(ourOutputDir, clientOutputDir);

  // Normalize to forward slashes for imports
  relativePath = relativePath.split(path.sep).join('/');

  // Ensure it starts with ./ or ../
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }

  // Prisma 7 generates client.ts as the main entry point, and ESM requires explicit file extensions
  return relativePath + '/client.js';
}

generatorHandler({
  onManifest(): {
    defaultOutput: string;
    prettyName: string;
    requiresGenerators: string[];
  } {
    return {
      defaultOutput: './generated/soft-cascade',
      prettyName: 'Prisma Soft Cascade',
      // Prisma 7+ uses prisma-client
      requiresGenerators: ['prisma-client'],
    };
  },

  async onGenerate(options): Promise<void> {
    const outputDir = options.generator.output?.value;

    if (outputDir === undefined || outputDir === null) {
      throw new Error('No output directory specified for prisma-safe-delete');
    }

    // Read custom config options
    const rawStrategy = options.generator.config['uniqueStrategy'] as string | undefined;
    const uniqueStrategy: UniqueStrategy =
      rawStrategy === 'none' ? 'none' : 'mangle'; // Default to 'mangle'

    // Find the Prisma client generator to get its output path
    const clientGenerator = options.otherGenerators.find(
      (g) => g.provider.value === 'prisma-client',
    );

    // Compute client import path - Prisma 7 requires explicit output
    const clientOutputPath = clientGenerator?.output?.value;
    if (
      clientOutputPath === undefined ||
      clientOutputPath === null ||
      clientOutputPath === ''
    ) {
      throw new Error(
        'prisma-safe-delete requires the prisma-client generator with an explicit output path. ' +
          'Please ensure your schema.prisma has:\n\n' +
          'generator client {\n' +
          '  provider = "prisma-client"\n' +
          '  output   = "./generated/client"\n' +
          '}',
      );
    }
    const clientImportPath = computeClientImportPath(outputDir, clientOutputPath);

    // Parse the DMMF
    const schema = parseDMMF(options.dmmf);

    // Emit warning if uniqueStrategy is 'none' and there are unique fields
    if (uniqueStrategy === 'none') {
      emitUniqueStrategyWarning(schema);
    }

    // Build the cascade graph
    const cascadeGraph = buildCascadeGraph(schema);

    // Generate all output files
    const typesContent = emitTypes(schema, clientImportPath);
    const cascadeGraphContent = emitCascadeGraph(cascadeGraph);
    const runtimeContent = emitRuntime(schema, clientImportPath, { uniqueStrategy, cascadeGraph });
    const indexContent = emitIndex(schema);

    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    // Write all files
    await Promise.all([
      fs.writeFile(path.join(outputDir, 'types.ts'), typesContent, 'utf-8'),
      fs.writeFile(
        path.join(outputDir, 'cascade-graph.ts'),
        cascadeGraphContent,
        'utf-8',
      ),
      fs.writeFile(path.join(outputDir, 'runtime.ts'), runtimeContent, 'utf-8'),
      fs.writeFile(path.join(outputDir, 'index.ts'), indexContent, 'utf-8'),
    ]);
  },
});

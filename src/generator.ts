import generatorHelper from '@prisma/generator-helper';
const { generatorHandler } = generatorHelper;
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDMMF, type ParsedSchema } from './dmmf-parser.js';
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
  fields: string[];
  deletedAtField: string;
}

/**
 * Collects models that have unique string fields requiring partial indexes.
 * Exported for testing.
 */
export function collectModelsWithUniqueFields(schema: ParsedSchema): UniqueFieldInfo[] {
  const result: UniqueFieldInfo[] = [];

  for (const model of schema.models) {
    if (model.isSoftDeletable && model.uniqueStringFields.length > 0 && model.deletedAtField !== null) {
      result.push({
        model: model.name,
        fields: model.uniqueStringFields,
        deletedAtField: model.deletedAtField,
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
  const c = useColors ? CYAN : '';
  const r = useColors ? RESET : '';
  const b = useColors ? BOLD : '';

  const lines: string[] = [
    '',
    `${y}${b}⚠️  prisma-safe-delete: uniqueStrategy is 'none'${r}`,
    `${y}   You must create partial unique indexes manually to prevent conflicts.${r}`,
    '',
    `${c}   Models requiring partial unique indexes:${r}`,
  ];

  for (const { model, fields } of modelsWithUniqueFields) {
    lines.push(`     - ${model}: ${fields.join(', ')}`);
  }

  lines.push('');
  lines.push(`${c}   Example SQL (PostgreSQL):${r}`);

  for (const { model, fields, deletedAtField } of modelsWithUniqueFields) {
    for (const field of fields) {
      const indexName = `${model.toLowerCase()}_${field}_active`;
      lines.push(`     CREATE UNIQUE INDEX ${indexName} ON "${model}"(${field}) WHERE ${deletedAtField} IS NULL;`);
    }
  }

  lines.push('');
  lines.push(`${y}   Without these indexes, soft-deleted records will block new records with the same unique values.${r}`);
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
    const runtimeContent = emitRuntime(schema, clientImportPath, { uniqueStrategy });
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

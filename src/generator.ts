import generatorHelper from '@prisma/generator-helper';
const { generatorHandler } = generatorHelper;
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseDMMF,
  type ParsedModel,
  type ParsedSchema,
  type UniqueConstraintInfo,
} from './dmmf-parser.js';
import { buildCascadeGraph } from './cascade-graph.js';
import {
  emitTypes,
  emitRuntime,
  emitCascadeGraph,
  emitIndex,
  hasAuditableModels,
  resolveAuditTableConfig,
} from './codegen/index.js';

/**
 * Strategy for handling unique constraints on soft delete.
 * - 'mangle': Append "__deleted_{pk}" suffix to unique string fields (default)
 * - 'none': Skip mangling; use this if you set up partial unique indexes yourself
 * - 'sentinel': Use a far-future sentinel date (9999-12-31) instead of NULL for active records,
 *   enabling @@unique([field, deleted_at]) compound constraints at the DB level
 */
export type UniqueStrategy = 'mangle' | 'none' | 'sentinel';

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
 * Result of validating unique constraints for a given schema and strategy.
 */
export interface UniqueConstraintValidation {
  warningLines: string[];
  hasIssues: boolean;
}

/**
 * Checks whether a sentinel-configured schema has any issues:
 * - Misconfigured deleted_at fields (nullable or missing @default)
 * - Standalone unique constraints that should include deleted_at
 */
function checkSentinelHasIssues(schema: ParsedSchema): boolean {
  const softDeletableModels = schema.models.filter(m => m.isSoftDeletable && m.deletedAtField !== null);
  if (softDeletableModels.length === 0) return false;

  const hasMisconfiguredFields = softDeletableModels.some(m => {
    const status = checkSentinelFieldConfig(m);
    return status !== null && !status.isCorrectlyConfigured;
  });

  const hasStandaloneUniques = softDeletableModels.some(m =>
    m.uniqueConstraints.some(c => !c.includesDeletedAt)
  );

  return hasMisconfiguredFields || hasStandaloneUniques;
}

/**
 * Validates unique constraints for a schema given the chosen unique strategy.
 * Returns warning lines for display and whether any issues were found.
 * Exported for testing.
 */
export function validateUniqueConstraints(
  schema: ParsedSchema,
  strategy: UniqueStrategy,
): UniqueConstraintValidation {
  if (strategy === 'none') {
    const modelsWithUniqueFields = collectModelsWithUniqueFields(schema);
    return {
      warningLines: buildUniqueStrategyWarningLines(modelsWithUniqueFields),
      hasIssues: modelsWithUniqueFields.length > 0,
    };
  }

  if (strategy === 'sentinel') {
    return {
      warningLines: buildSentinelWarningLines(schema),
      hasIssues: checkSentinelHasIssues(schema),
    };
  }

  // mangle
  const lines = buildMangleWarningLines(schema);
  return {
    warningLines: lines,
    hasIssues: lines.length > 0,
  };
}

/**
 * Info about a unique field that cannot be mangled.
 */
interface UnmangleableFieldInfo {
  model: string;
  deletedAtField: string;
  fieldName: string;
  fieldType: string;
}

/**
 * Builds warning lines for mangle strategy when there are unique fields that
 * cannot be mangled (non-string types, UUID native types, etc.).
 * Exported for testing.
 */
export function buildMangleWarningLines(
  schema: ParsedSchema,
  useColors = true,
): string[] {
  const softDeletableModels = schema.models.filter(m => m.isSoftDeletable && m.deletedAtField !== null);
  if (softDeletableModels.length === 0) return [];

  const unmangleableFields: UnmangleableFieldInfo[] = [];

  for (const model of softDeletableModels) {
    const deletedAtField = model.deletedAtField ?? 'deleted_at';
    const mangleableSet = new Set(model.uniqueStringFields);

    for (const fieldName of model.allUniqueFields) {
      // Skip deleted_at itself
      if (fieldName === model.deletedAtField) continue;
      if (!mangleableSet.has(fieldName)) {
        const field = model.fields.find(f => f.name === fieldName);
        unmangleableFields.push({
          model: model.name,
          deletedAtField,
          fieldName,
          fieldType: field?.type ?? 'unknown',
        });
      }
    }
  }

  if (unmangleableFields.length === 0) return [];

  const y = useColors ? YELLOW : '';
  const cn = useColors ? CYAN : '';
  const r = useColors ? RESET : '';
  const b = useColors ? BOLD : '';

  const lines: string[] = [
    '',
    `${y}${b}⚠️  prisma-safe-delete: uniqueStrategy is 'mangle'${r}`,
    `${y}   Some unique fields cannot be mangled and need partial unique indexes instead.${r}`,
    `${y}   Mangling only works on String fields (excluding @db.Uuid).${r}`,
    '',
  ];

  // Group by model
  const byModel = new Map<string, UnmangleableFieldInfo[]>();
  for (const info of unmangleableFields) {
    const existing = byModel.get(info.model) ?? [];
    existing.push(info);
    byModel.set(info.model, existing);
  }

  lines.push(`${cn}   Fields requiring partial unique indexes:${r}`);
  for (const [model, fields] of byModel) {
    const desc = fields.map(f => `${f.fieldName} (${f.fieldType})`).join(', ');
    lines.push(`     - ${model}: ${desc}`);
  }

  lines.push('');
  lines.push(`${cn}   Example SQL (PostgreSQL):${r}`);
  for (const info of unmangleableFields) {
    const indexName = `${info.model.toLowerCase()}_${info.fieldName}_active`;
    lines.push(
      `     CREATE UNIQUE INDEX ${indexName} ON "${info.model}"(${info.fieldName}) WHERE ${info.deletedAtField} IS NULL;`,
    );
  }

  lines.push('');

  return lines;
}


/**
 * Sentinel field configuration status for a model.
 */
interface SentinelFieldStatus {
  model: string;
  deletedAtField: string;
  /** true if the field is non-nullable with a default (correct for sentinel) */
  isCorrectlyConfigured: boolean;
  /** true if the field is nullable (traditional mangle/none pattern) */
  isNullable: boolean;
}

/**
 * Checks whether a soft-deletable model's deleted_at field is correctly configured
 * for the sentinel strategy (non-nullable DateTime with @default).
 */
function checkSentinelFieldConfig(model: ParsedModel): SentinelFieldStatus | null {
  if (!model.isSoftDeletable || model.deletedAtField === null) return null;

  const field = model.fields.find(f => f.name === model.deletedAtField);
  if (field === undefined) return null;

  return {
    model: model.name,
    deletedAtField: model.deletedAtField,
    isCorrectlyConfigured: field.isRequired && field.hasDefaultValue,
    isNullable: !field.isRequired,
  };
}

/**
 * Builds warning lines for sentinel strategy.
 * Validates per-model field configuration and unique constraint setup.
 * Exported for testing.
 */
export function buildSentinelWarningLines(
  schema: ParsedSchema,
  useColors = true,
): string[] {
  const softDeletableModels = schema.models.filter(m => m.isSoftDeletable && m.deletedAtField !== null);
  if (softDeletableModels.length === 0) return [];

  const y = useColors ? YELLOW : '';
  const cn = useColors ? CYAN : '';
  const r = useColors ? RESET : '';
  const b = useColors ? BOLD : '';

  const lines: string[] = [
    '',
    `${y}${b}ℹ️  prisma-safe-delete: uniqueStrategy is 'sentinel'${r}`,
    `${y}   Active records use deleted_at = '9999-12-31' (sentinel) instead of NULL.${r}`,
  ];

  // Check each model's deleted_at field configuration
  const fieldStatuses = softDeletableModels
    .map(m => checkSentinelFieldConfig(m))
    .filter((s): s is SentinelFieldStatus => s !== null);

  const misconfiguredFields = fieldStatuses.filter(s => !s.isCorrectlyConfigured);
  const correctlyConfiguredFields = fieldStatuses.filter(s => s.isCorrectlyConfigured);

  if (misconfiguredFields.length > 0) {
    lines.push('');
    lines.push(`${y}${b}   ⚠️  deleted_at field misconfigured for sentinel strategy:${r}`);
    for (const status of misconfiguredFields) {
      if (status.isNullable) {
        lines.push(`     - ${status.model}: ${status.deletedAtField} is nullable (DateTime?) — must be non-nullable with @default`);
      } else {
        lines.push(`     - ${status.model}: ${status.deletedAtField} is non-nullable but missing @default`);
      }
    }
    lines.push(`${cn}   Required: ${misconfiguredFields[0]?.deletedAtField ?? 'deleted_at'} DateTime @default(dbgenerated("'9999-12-31 00:00:00'"))${r}`);
    lines.push(`${cn}   Migration: UPDATE "Model" SET ${misconfiguredFields[0]?.deletedAtField ?? 'deleted_at'} = '9999-12-31' WHERE ${misconfiguredFields[0]?.deletedAtField ?? 'deleted_at'} IS NULL${r}`);
  }

  // List models with unique constraints that include deleted_at (good pattern for sentinel)
  const modelsWithCompound = softDeletableModels.filter(m =>
    m.uniqueConstraints.some(c => c.includesDeletedAt)
  );
  if (modelsWithCompound.length > 0 || correctlyConfiguredFields.length > 0) {
    lines.push('');
    lines.push(`${cn}   Correctly configured:${r}`);
    // Show field config status for correctly configured models
    for (const status of correctlyConfiguredFields) {
      const model = softDeletableModels.find(m => m.name === status.model);
      const compounds = model?.uniqueConstraints.filter(c => c.includesDeletedAt) ?? [];
      if (compounds.length > 0) {
        const desc = compounds.map(c => `@@unique([${c.fields.join(', ')}, ${status.deletedAtField}])`).join(', ');
        lines.push(`     - ${status.model}: ${status.deletedAtField} ✓, ${desc}`);
      } else {
        lines.push(`     - ${status.model}: ${status.deletedAtField} ✓`);
      }
    }
  }

  // Warn about standalone @unique fields that should be compound
  const modelsWithStandalone = softDeletableModels.filter(m =>
    m.uniqueConstraints.some(c => !c.includesDeletedAt)
  );
  if (modelsWithStandalone.length > 0) {
    lines.push('');
    lines.push(`${y}${b}   ⚠️  Standalone unique constraints detected (should include deleted_at):${r}`);
    for (const model of modelsWithStandalone) {
      const standalones = model.uniqueConstraints.filter(c => !c.includesDeletedAt);
      const desc = standalones.map(c =>
        c.fields.length > 1 ? `(${c.fields.join(', ')})` : c.fields[0]
      ).join(', ');
      lines.push(`     - ${model.name}: ${desc}`);
    }
    lines.push(`${cn}   Convert to compound: @@unique([field, ${softDeletableModels[0]?.deletedAtField ?? 'deleted_at'}])${r}`);
  }

  // If there are no issues at all, show a brief confirmation
  if (misconfiguredFields.length === 0 && modelsWithStandalone.length === 0) {
    lines.push('');
    lines.push(`${cn}   All models correctly configured for sentinel strategy.${r}`);
  }

  lines.push('');

  return lines;
}


/**
 * Info about a required to-one relation to a soft-deletable model.
 */
export interface ToOneRelationWarningInfo {
  sourceModel: string;
  relationField: string;
  targetModel: string;
  isRequired: boolean;
}

/**
 * Builds warning lines for required to-one relations pointing to soft-deletable models.
 * At runtime, these relations may return null when the target is soft-deleted,
 * even though Prisma's types say they're non-nullable.
 * Exported for testing.
 */
export function buildToOneRelationWarningLines(
  schema: ParsedSchema,
  useColors = true,
): string[] {
  const warnings: ToOneRelationWarningInfo[] = [];

  for (const model of schema.models) {
    for (const relation of model.relations) {
      if (relation.isList) continue;
      const target = schema.modelMap.get(relation.type);
      if (target?.isSoftDeletable !== true) continue;
      if (relation.isRequired) {
        warnings.push({
          sourceModel: model.name,
          relationField: relation.name,
          targetModel: relation.type,
          isRequired: true,
        });
      }
    }
  }

  if (warnings.length === 0) return [];

  const y = useColors ? YELLOW : '';
  const cn = useColors ? CYAN : '';
  const r = useColors ? RESET : '';
  const b = useColors ? BOLD : '';

  const lines: string[] = [
    '',
    `${y}${b}ℹ️  prisma-safe-delete: Required to-one relations to soft-deletable models${r}`,
    `${y}   At runtime, these relations will return null when the target is soft-deleted,${r}`,
    `${y}   even though Prisma types say they are non-nullable. Consider making them optional.${r}`,
    '',
  ];

  for (const w of warnings) {
    lines.push(`${cn}     ${w.sourceModel}.${w.relationField} -> ${w.targetModel}${r}`);
  }

  lines.push('');

  return lines;
}

/**
 * Validates the audit table has the required columns when auditable models exist.
 * Throws descriptive errors at generation time.
 */
function validateAuditSetup(schema: ParsedSchema): void {
  const auditableModels = schema.models.filter((m) => m.isAuditable);
  if (auditableModels.length === 0) return;

  // Check for multiple @audit-table models
  const auditTables = schema.models.filter((m) => m.isAuditTable);
  if (auditTables.length > 1) {
    const names = auditTables.map((m) => m.name).join(', ');
    throw new Error(
      `prisma-safe-delete: Multiple @audit-table models found: ${names}. Only one audit table is allowed.`,
    );
  }

  // Must have an audit table
  if (schema.auditTable === null) {
    throw new Error(
      'prisma-safe-delete: Models marked with @audit exist but no @audit-table model was found.\n' +
        'Add /// @audit-table to your audit events model. Required columns:\n' +
        '  entity_type String\n' +
        '  entity_id   String\n' +
        '  action      String\n' +
        '  actor_id    String?\n' +
        '  event_data  Json\n' +
        '  created_at  DateTime',
    );
  }

  // Validate required columns
  const table = schema.auditTable;
  const fieldMap = new Map(table.fields.map((f) => [f.name, f]));

  const requiredColumns: { name: string; type: string; nullable: boolean }[] = [
    { name: 'entity_type', type: 'String', nullable: false },
    { name: 'entity_id', type: 'String', nullable: false },
    { name: 'action', type: 'String', nullable: false },
    { name: 'actor_id', type: 'String', nullable: true },
    { name: 'event_data', type: 'Json', nullable: false },
    { name: 'created_at', type: 'DateTime', nullable: false },
  ];

  const errors: string[] = [];
  for (const col of requiredColumns) {
    const field = fieldMap.get(col.name);
    if (field === undefined) {
      errors.push(`  Missing column: ${col.name} ${col.type}${col.nullable ? '?' : ''}`);
    } else if (field.type !== col.type) {
      errors.push(
        `  Column ${col.name}: expected type ${col.type}, got ${field.type}`,
      );
    } else if (!col.nullable && !field.isRequired) {
      errors.push(
        `  Column ${col.name}: must be required (not nullable)`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `prisma-safe-delete: Audit table "${table.name}" has invalid columns:\n${errors.join('\n')}`,
    );
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
      rawStrategy === 'none' ? 'none'
      : rawStrategy === 'sentinel' ? 'sentinel'
      : 'mangle'; // Default to 'mangle'

    const rawCascade = options.generator.config['cascade'] as string | undefined;
    if (rawCascade !== undefined && rawCascade !== 'true' && rawCascade !== 'false') {
      // eslint-disable-next-line no-console
      console.warn(`prisma-safe-delete: Unknown cascade value "${rawCascade}". Expected "true" or "false". Defaulting to "true".`);
    }
    const cascade = rawCascade !== 'false';
    const strictUniqueChecks = options.generator.config['strictUniqueChecks'] === 'true';
    const deletedAtFieldName = options.generator.config['deletedAtField'] as string | undefined;
    const deletedByFieldName = options.generator.config['deletedByField'] as string | undefined;

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
    const schema = parseDMMF(options.dmmf, {
      ...(deletedAtFieldName !== undefined ? { deletedAtField: deletedAtFieldName } : {}),
      ...(deletedByFieldName !== undefined ? { deletedByField: deletedByFieldName } : {}),
    });

    // Validate unique constraints and emit warnings
    const validation = validateUniqueConstraints(schema, uniqueStrategy);
    if (validation.warningLines.length > 0) {
      // eslint-disable-next-line no-console
      console.log(validation.warningLines.join('\n'));
    }
    if (strictUniqueChecks && validation.hasIssues) {
      throw new Error(
        'prisma-safe-delete: Unique constraint issues detected and strictUniqueChecks is enabled. See warnings above.'
      );
    }

    // Emit to-one relation warnings (info-level, not blocking)
    const toOneWarnings = buildToOneRelationWarningLines(schema);
    if (toOneWarnings.length > 0) {
      // eslint-disable-next-line no-console
      console.log(toOneWarnings.join('\n'));
    }

    // Validate audit setup (throws on misconfiguration)
    validateAuditSetup(schema);
    const auditTable = hasAuditableModels(schema) ? resolveAuditTableConfig(schema) : null;

    // Build the cascade graph (empty when cascade is disabled)
    const cascadeGraph = cascade ? buildCascadeGraph(schema) : {};

    // Generate all output files
    const typesContent = emitTypes(schema, clientImportPath);
    const cascadeGraphContent = emitCascadeGraph(cascadeGraph);
    const runtimeContent = emitRuntime(schema, clientImportPath, { uniqueStrategy, cascadeGraph, auditTable });
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

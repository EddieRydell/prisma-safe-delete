import type { ParsedSchema } from '../dmmf-parser.js';

/**
 * Extra column on the audit table beyond the built-in columns.
 * Used to generate a typed AuditContext interface.
 */
export interface AuditExtraColumn {
  name: string;
  prismaType: string; // 'String', 'DateTime', etc.
  isRequired: boolean;
}

/**
 * Audit table configuration resolved at generation time.
 */
export interface AuditTableConfig {
  /** PascalCase model name (e.g. 'AuditEvent') */
  modelName: string;
  /** lowerCamelCase name for Prisma delegate (e.g. 'auditEvent') */
  lowerName: string;
  /** Primary key field(s) of the audit table */
  pkField: string | string[];
  /** Whether the audit table has a parent_event_id column */
  hasParentEventId: boolean;
  /** Extra columns beyond the built-in audit columns */
  extraColumns: AuditExtraColumn[];
}

/**
 * Maps Prisma scalar types to TypeScript types for AuditContext interface generation.
 */
export function prismaTypeToTsType(prismaType: string): string {
  switch (prismaType) {
    case 'String':
      return 'string';
    case 'Int':
    case 'Float':
    case 'Decimal':
      return 'number';
    case 'BigInt':
      return 'bigint';
    case 'Boolean':
      return 'boolean';
    case 'DateTime':
      return 'Date';
    case 'Json':
      return 'unknown';
    case 'Bytes':
      return 'Buffer';
    default:
      return 'unknown';
  }
}

function toLowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Emits audit helper functions and metadata into the runtime output.
 * Only called when the schema has auditable models and an audit table.
 */
export function emitAuditHelpers(schema: ParsedSchema, config: AuditTableConfig): string {
  const lines: string[] = [];

  // Emit AUDITABLE_MODELS metadata
  lines.push('/** Metadata about auditable models */');
  lines.push('const AUDITABLE_MODELS: Record<string, { actions: string[] }> = {');
  for (const model of schema.models) {
    if (model.isAuditable) {
      lines.push(`  ${model.name}: { actions: ${JSON.stringify(model.auditActions)} },`);
    }
  }
  lines.push('};');
  lines.push('');

  // Emit audit table name constant
  lines.push(`const AUDIT_TABLE_NAME = ${JSON.stringify(config.lowerName)};`);
  lines.push(`const AUDIT_TABLE_MODEL_NAME = ${JSON.stringify(config.modelName)};`);
  lines.push(`const AUDIT_TABLE_HAS_PARENT_EVENT_ID = ${String(config.hasParentEventId)};`);
  // Emit whitelist of allowed extra columns for audit context validation
  const extraColNames = config.extraColumns.map((c) => JSON.stringify(c.name));
  lines.push(`const AUDIT_EXTRA_COLUMNS: ReadonlySet<string> = new Set([${extraColNames.join(', ')}]);`);
  lines.push('');

  // Emit writeAuditEvent function
  lines.push(`/**
 * Writes a single audit event to the audit table within a transaction.
 * Returns the generated event ID (for parent_event_id linking).
 */
async function writeAuditEvent(
  tx: Prisma.TransactionClient,
  entityType: string,
  entityId: string,
  action: string,
  actorId: string | null,
  eventData: unknown,
  parentEventId?: string,
  context?: Record<string, unknown>,
): Promise<string> {
  const delegate = tx[AUDIT_TABLE_NAME as keyof typeof tx] as any;
  // Filter context to only known extra columns — prevents unknown keys from reaching the database
  const filteredContext: Record<string, unknown> = {};
  if (context) {
    for (const key of Object.keys(context)) {
      if (AUDIT_EXTRA_COLUMNS.has(key)) {
        filteredContext[key] = context[key];
      }
    }
  }
  const data: Record<string, unknown> = {
    ...filteredContext,
    entity_type: entityType,
    entity_id: entityId,
    action,
    actor_id: actorId,
    event_data: eventData,
    // created_at intentionally omitted — relies on @default(now()) for tamper-resistant server-side timestamps.
    // validateAuditSetup() enforces that the audit table's created_at has @default(now()).
    ...(AUDIT_TABLE_HAS_PARENT_EVENT_ID ? { parent_event_id: parentEventId ?? null } : {}),
  };
  const event = await delegate.create({ data });
  const pk = PRIMARY_KEYS[AUDIT_TABLE_MODEL_NAME];
  if (Array.isArray(pk)) {
    const obj: Record<string, unknown> = {};
    for (const field of pk) obj[field] = event[field];
    return JSON.stringify(obj);
  }
  const pkValue = event[pk as string];
  if (pkValue === undefined || pkValue === null) {
    throw new Error(
      \`[prisma-safe-delete] writeAuditEvent: could not extract PK '\${String(pk)}' from created audit event. Check that your @audit-table model's primary key is correctly configured.\`
    );
  }
  return String(pkValue);
}`);
  lines.push('');

  // Emit isAuditable helper
  lines.push(`/**
 * Checks if a model+action combination is auditable.
 */
function isAuditable(modelName: string, action: string): boolean {
  const config = AUDITABLE_MODELS[modelName];
  return config !== undefined && config.actions.includes(action);
}`);
  lines.push('');

  // Emit getEntityId helper
  lines.push(`/**
 * Extracts a string entity ID from a record for audit logging.
 * For compound PKs, returns a JSON object string.
 */
function getEntityId(modelName: string, record: Record<string, unknown>): string {
  const pk = PRIMARY_KEYS[modelName];
  if (Array.isArray(pk)) {
    const obj: Record<string, unknown> = {};
    for (const field of pk) {
      const val = record[field];
      if (val === undefined || val === null) {
        throw new Error(\`[prisma-safe-delete] getEntityId: PK field '\${field}' is \${String(val)} on model '\${modelName}'. Cannot generate audit entity_id.\`);
      }
      obj[field] = val;
    }
    return JSON.stringify(obj);
  }
  const pkValue = record[pk as string];
  if (pkValue === undefined || pkValue === null) {
    throw new Error(\`[prisma-safe-delete] getEntityId: PK field '\${String(pk)}' is \${String(pkValue)} on model '\${modelName}'. Cannot generate audit entity_id.\`);
  }
  return String(pkValue);
}`);
  lines.push('');

  // Emit shared audit operation helpers
  lines.push(emitAuditOperationHelpers());
  lines.push('');

  return lines.join('\n');
}

/**
 * Emits shared _audited* helper functions that encapsulate audit logic.
 * Both main delegates and tx wrappers call these, eliminating code duplication.
 * Each helper takes a tx + delegate so it works in both contexts.
 */
function emitAuditOperationHelpers(): string {
  return `
/**
 * Merges global auditContext callback result with per-call callCtx.
 * Per-call values override global values.
 */
async function _mergeAuditContext(
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const globalCtx = await wrapOptions?.auditContext?.();
  if (!globalCtx && !callCtx) return undefined;
  return { ...globalCtx, ...callCtx };
}

/**
 * Audited create: create record, write audit event, return record.
 */
async function _auditedCreate(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  const record = await delegate.create(args);
  const ctx = await _mergeAuditContext(wrapOptions, callCtx);
  await writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'create', actorId, record, undefined, ctx);
  return record;
}

/**
 * Audited createMany: uses createManyAndReturn to get records for audit, returns BatchPayload.
 */
async function _auditedCreateMany(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<{ count: number }> {
  const records = await delegate.createManyAndReturn(args);
  const ctx = await _mergeAuditContext(wrapOptions, callCtx);
  await Promise.all(records.map((record: any) =>
    writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'create', actorId, record, undefined, ctx),
  ));
  return { count: records.length };
}

/**
 * Audited createManyAndReturn: create records, write audit events, return records.
 */
async function _auditedCreateManyAndReturn(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any[]> {
  const records = await delegate.createManyAndReturn(args);
  const ctx = await _mergeAuditContext(wrapOptions, callCtx);
  await Promise.all(records.map((record: any) =>
    writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'create', actorId, record, undefined, ctx),
  ));
  return records;
}

/**
 * Audited update: fetch before-state, update, write audit event, return after.
 */
async function _auditedUpdate(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  const before = await delegate.findUniqueOrThrow({ where: args.where });
  const after = await delegate.update(args);
  const ctx = await _mergeAuditContext(wrapOptions, callCtx);
  await writeAuditEvent(tx, modelName, getEntityId(modelName, after), 'update', actorId, { before, after }, undefined, ctx);
  return after;
}

/**
 * Audited updateMany: fetch before-state, updateMany, PK-match after records, audit each.
 */
async function _auditedUpdateMany(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  const beforeRecords = await delegate.findMany({ where: args.where });
  const result = await delegate.updateMany(args);
  if (beforeRecords.length > 0) {
    const pks = beforeRecords.map((r: any) => extractPrimaryKey(modelName, r));
    const afterRecords = await delegate.findMany({
      where: { OR: pks.map((pk: any) => createPkWhereFromValues(modelName, pk)) },
    });
    const ctx = await _mergeAuditContext(wrapOptions, callCtx);
    await Promise.all(beforeRecords.map((before: any) => {
      const pk = extractPrimaryKey(modelName, before);
      const after = afterRecords.find((r: any) => JSON.stringify(extractPrimaryKey(modelName, r)) === JSON.stringify(pk));
      if (!after) {
        throw new Error(
          \`[prisma-safe-delete] _auditedUpdateMany: record \${JSON.stringify(pk)} for model '\${modelName}' was present before updateMany but missing after. This indicates a concurrent modification — aborting to preserve audit completeness.\`,
        );
      }
      return writeAuditEvent(tx, modelName, getEntityId(modelName, after), 'update', actorId, { before, after }, undefined, ctx);
    }));
  }
  return result;
}

/**
 * Audited updateManyAndReturn: fetch before-state, updateManyAndReturn, PK-match, audit each.
 */
async function _auditedUpdateManyAndReturn(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any[]> {
  const beforeRecords = await delegate.findMany({ where: args.where });
  const results = await delegate.updateManyAndReturn(args);
  const ctx = await _mergeAuditContext(wrapOptions, callCtx);
  await Promise.all(results.map((after: any) => {
    const pk = extractPrimaryKey(modelName, after);
    const before = beforeRecords.find((r: any) => JSON.stringify(extractPrimaryKey(modelName, r)) === JSON.stringify(pk));
    if (!before) {
      throw new Error(
        \`[prisma-safe-delete] _auditedUpdateManyAndReturn: record \${JSON.stringify(pk)} for model '\${modelName}' exists in results but had no before-state. This indicates a concurrent modification — aborting to preserve audit completeness.\`,
      );
    }
    return writeAuditEvent(tx, modelName, getEntityId(modelName, after), 'update', actorId, { before, after }, undefined, ctx);
  }));
  return results;
}

/**
 * Audited upsert: check existence, upsert, determine action at runtime, audit if action is auditable.
 */
async function _auditedUpsert(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  const existing = await delegate.findUnique({ where: args.where });
  const result = await delegate.upsert(args);
  const action = existing ? 'update' : 'create';
  const eventData = existing ? { before: existing, after: result } : result;
  if (isAuditable(modelName, action)) {
    const ctx = await _mergeAuditContext(wrapOptions, callCtx);
    await writeAuditEvent(tx, modelName, getEntityId(modelName, result), action, actorId, eventData, undefined, ctx);
  }
  return result;
}

/**
 * Audited delete: capture pre-mutation snapshot, write audit event, then delete.
 * Snapshot is captured before deletion for consistent audit ordering with soft-delete.
 */
async function _auditedDelete(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  const snapshot = await delegate.findUniqueOrThrow({ where: args.where });
  const ctx = await _mergeAuditContext(wrapOptions, callCtx);
  await writeAuditEvent(tx, modelName, getEntityId(modelName, snapshot), 'delete', actorId, snapshot, undefined, ctx);
  return delegate.delete(args);
}

/**
 * Audited deleteMany: fetch pre-mutation snapshots, write audit events, then deleteMany.
 */
async function _auditedDeleteMany(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  const records = await delegate.findMany({ where: args?.where });
  const ctx = await _mergeAuditContext(wrapOptions, callCtx);
  await Promise.all(records.map((record: any) =>
    writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'delete', actorId, record, undefined, ctx),
  ));
  return delegate.deleteMany(args);
}

/**
 * Audited hard delete: permanently delete record, write audit event with 'hard_delete' action, return record.
 * Gated on isAuditable(modelName, 'delete') — hard deletes are a subset of delete operations,
 * so models must have 'delete' in their @audit config to get hard_delete events.
 */
async function _auditedHardDelete(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  if (isAuditable(modelName, 'delete')) {
    const snapshot = await delegate.findUniqueOrThrow({ where: args.where });
    const ctx = await _mergeAuditContext(wrapOptions, callCtx);
    await writeAuditEvent(tx, modelName, getEntityId(modelName, snapshot), 'hard_delete', actorId, snapshot, undefined, ctx);
  }
  return delegate.delete(args);
}

/**
 * Audited hard deleteMany: fetch records, permanently deleteMany, write audit events with 'hard_delete' action, return result.
 * Gated on isAuditable(modelName, 'delete') — see _auditedHardDelete comment.
 */
async function _auditedHardDeleteMany(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
  callCtx?: Record<string, unknown>,
): Promise<any> {
  const records = await delegate.findMany({ where: args?.where });
  if (isAuditable(modelName, 'delete') && records.length > 0) {
    const ctx = await _mergeAuditContext(wrapOptions, callCtx);
    await Promise.all(records.map((record: any) =>
      writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'hard_delete', actorId, record, undefined, ctx),
    ));
  }
  return delegate.deleteMany(args);
}`.trim();
}

/**
 * Checks whether a schema has any auditable models.
 */
export function hasAuditableModels(schema: ParsedSchema): boolean {
  return schema.models.some((m) => m.isAuditable);
}

/**
 * Resolves the AuditTableConfig from the parsed schema.
 * Returns null if no audit table is found.
 */
export function resolveAuditTableConfig(schema: ParsedSchema): AuditTableConfig | null {
  if (schema.auditTable === null) return null;

  const model = schema.auditTable;
  // Only String (nullable) parent_event_id fields are supported for cascade linking.
  // If parent_event_id exists but is a different type (e.g. Int), it will be silently
  // ignored. The PK returned by writeAuditEvent is always a String (via JSON.stringify
  // for composite keys or String() for scalar keys), so the parent_event_id column
  // must be String? to receive it.
  const hasParentEventId = model.fields.some(
    (f) => f.name === 'parent_event_id' && f.type === 'String' && !f.isRequired,
  );

  // Built-in columns that are not "extra"
  const builtInColumns = new Set([
    'entity_type', 'entity_id', 'action', 'actor_id', 'event_data', 'created_at', 'parent_event_id',
  ]);
  // PK fields are also not extra
  const pkFields = new Set(Array.isArray(model.primaryKey) ? model.primaryKey : [model.primaryKey]);

  const extraColumns: AuditExtraColumn[] = [];
  for (const field of model.fields) {
    if (builtInColumns.has(field.name)) continue;
    if (pkFields.has(field.name)) continue;
    if (field.isRelation) continue;
    extraColumns.push({
      name: field.name,
      prismaType: field.type,
      isRequired: field.isRequired,
    });
  }

  return {
    modelName: model.name,
    lowerName: toLowerFirst(model.name),
    pkField: model.primaryKey,
    hasParentEventId,
    extraColumns,
  };
}

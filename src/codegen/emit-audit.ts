import type { ParsedSchema } from '../dmmf-parser.js';

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
  const data: Record<string, unknown> = {
    entity_type: entityType,
    entity_id: entityId,
    action,
    actor_id: actorId,
    event_data: eventData,
    created_at: new Date(),
    ...(AUDIT_TABLE_HAS_PARENT_EVENT_ID && parentEventId !== undefined ? { parent_event_id: parentEventId } : {}),
    ...(context ?? {}),
  };
  const event = await delegate.create({ data });
  const pk = PRIMARY_KEYS[AUDIT_TABLE_MODEL_NAME];
  if (Array.isArray(pk)) {
    const obj: Record<string, unknown> = {};
    for (const field of pk) obj[field] = event[field];
    return JSON.stringify(obj);
  }
  return String(event[pk as string] ?? event.id ?? '');
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
    for (const field of pk) obj[field] = record[field];
    return JSON.stringify(obj);
  }
  return String(record[pk as string] ?? '');
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
 * Audited create: create record, write audit event, return record.
 */
async function _auditedCreate(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
): Promise<any> {
  const record = await delegate.create(args);
  const ctx = await wrapOptions?.auditContext?.();
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
): Promise<{ count: number }> {
  const records = await delegate.createManyAndReturn(args);
  const ctx = await wrapOptions?.auditContext?.();
  for (const record of records) {
    await writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'create', actorId, record, undefined, ctx);
  }
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
): Promise<any[]> {
  const records = await delegate.createManyAndReturn(args);
  const ctx = await wrapOptions?.auditContext?.();
  for (const record of records) {
    await writeAuditEvent(tx, modelName, getEntityId(modelName, record as any), 'create', actorId, record, undefined, ctx);
  }
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
): Promise<any> {
  const before = await delegate.findUniqueOrThrow({ where: args.where });
  const after = await delegate.update(args);
  const ctx = await wrapOptions?.auditContext?.();
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
): Promise<any> {
  const beforeRecords = await delegate.findMany({ where: args.where });
  const result = await delegate.updateMany(args);
  if (beforeRecords.length > 0) {
    const pks = beforeRecords.map((r: any) => extractPrimaryKey(modelName, r));
    const afterRecords = await delegate.findMany({
      where: { OR: pks.map((pk: any) => createPkWhereFromValues(modelName, pk)) },
    });
    const ctx = await wrapOptions?.auditContext?.();
    for (const before of beforeRecords) {
      const pk = extractPrimaryKey(modelName, before);
      const after = afterRecords.find((r: any) => JSON.stringify(extractPrimaryKey(modelName, r)) === JSON.stringify(pk));
      if (after) {
        await writeAuditEvent(tx, modelName, getEntityId(modelName, after), 'update', actorId, { before, after }, undefined, ctx);
      }
    }
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
): Promise<any[]> {
  const beforeRecords = await delegate.findMany({ where: args.where });
  const results = await delegate.updateManyAndReturn(args);
  const ctx = await wrapOptions?.auditContext?.();
  for (const after of results) {
    const pk = extractPrimaryKey(modelName, after as any);
    const before = beforeRecords.find((r: any) => JSON.stringify(extractPrimaryKey(modelName, r)) === JSON.stringify(pk));
    if (before) {
      await writeAuditEvent(tx, modelName, getEntityId(modelName, after as any), 'update', actorId, { before, after }, undefined, ctx);
    }
  }
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
): Promise<any> {
  const existing = await delegate.findUnique({ where: args.where });
  const result = await delegate.upsert(args);
  const action = existing ? 'update' : 'create';
  const eventData = existing ? { before: existing, after: result } : result;
  if (isAuditable(modelName, action)) {
    const ctx = await wrapOptions?.auditContext?.();
    await writeAuditEvent(tx, modelName, getEntityId(modelName, result), action, actorId, eventData, undefined, ctx);
  }
  return result;
}

/**
 * Audited delete: delete record, write audit event, return record.
 */
async function _auditedDelete(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
): Promise<any> {
  const record = await delegate.delete(args);
  const ctx = await wrapOptions?.auditContext?.();
  await writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'delete', actorId, record, undefined, ctx);
  return record;
}

/**
 * Audited deleteMany: fetch records, deleteMany, write audit events, return result.
 */
async function _auditedDeleteMany(
  tx: Prisma.TransactionClient,
  delegate: any,
  args: any,
  modelName: string,
  actorId: string | null,
  wrapOptions: any,
): Promise<any> {
  const records = await delegate.findMany({ where: args?.where });
  const result = await delegate.deleteMany(args);
  const ctx = await wrapOptions?.auditContext?.();
  for (const record of records) {
    await writeAuditEvent(tx, modelName, getEntityId(modelName, record), 'delete', actorId, record, undefined, ctx);
  }
  return result;
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
  const hasParentEventId = model.fields.some(
    (f) => f.name === 'parent_event_id' && f.type === 'String' && !f.isRequired,
  );

  return {
    modelName: model.name,
    lowerName: toLowerFirst(model.name),
    pkField: model.primaryKey,
    hasParentEventId,
  };
}

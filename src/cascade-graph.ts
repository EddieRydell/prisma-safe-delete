import type { ParsedSchema, SoftDeletableModel } from './dmmf-parser.js';

/**
 * Represents a child model in a cascade relationship
 */
export interface CascadeChild {
  /** The name of the child model */
  model: string;
  /** The foreign key field(s) on the child model */
  foreignKey: string[];
  /** The field(s) on the parent model that the FK references (usually the primary key, but can be any unique field) */
  parentKey: string[];
  /** Whether the child model supports soft deletion */
  isSoftDeletable: boolean;
  /** The name of the deleted_at field if soft-deletable */
  deletedAtField: string | null;
  /** The name of the deleted_by field if present */
  deletedByField: string | null;
}

/**
 * Maps parent model names to their cascade children
 * When a parent is soft-deleted, all children in this map should be cascaded
 */
export type CascadeGraph = Record<string, CascadeChild[]>;

/**
 * Builds a cascade graph from a parsed schema
 *
 * The graph maps parent model names to lists of child models that should be
 * soft-deleted when the parent is soft-deleted. Only relations with
 * onDelete: Cascade are included.
 *
 * @param schema - The parsed Prisma schema
 * @returns A cascade graph mapping parents to children
 */
export function buildCascadeGraph(schema: ParsedSchema): CascadeGraph {
  const graph: CascadeGraph = {};

  // Initialize empty arrays for all models
  for (const model of schema.models) {
    graph[model.name] = [];
  }

  // For each model, look at its relations to find cascade relationships
  for (const model of schema.models) {
    for (const relation of model.relations) {
      // We only care about relations that have onDelete: Cascade
      if (relation.onDelete !== 'Cascade') {
        continue;
      }

      // Skip list relations - they're the "one" side, we want the "many" side
      // The relation with the foreign key is the child
      if (relation.isList) {
        continue;
      }

      // This model (with the FK) is the child, relation.type is the parent
      const parentModelName = relation.type;
      const parentModel = schema.modelMap.get(parentModelName);

      if (parentModel === undefined) {
        continue;
      }

      // Get the parent key that the FK references.
      // Use the relation's `references` (DMMF relationToFields) when available,
      // falling back to the parent's primary key for the common case.
      const parentKey =
        relation.references.length > 0
          ? relation.references
          : normalizeKey(parentModel.primaryKey);
      const foreignKey = relation.foreignKey;

      // Skip if we don't have FK information
      if (foreignKey.length === 0) {
        continue;
      }

      // Get or create the children array for this parent
      let children = graph[parentModelName];
      if (children === undefined) {
        children = [];
        graph[parentModelName] = children;
      }

      children.push({
        model: model.name,
        foreignKey,
        parentKey,
        isSoftDeletable: model.isSoftDeletable,
        deletedAtField: model.deletedAtField,
        deletedByField: model.deletedByField,
      });
    }
  }

  return graph;
}

/**
 * Normalizes a primary key to always be an array
 */
function normalizeKey(key: string | string[]): string[] {
  return Array.isArray(key) ? key : [key];
}

/**
 * Gets all models that would be affected by cascading from a given model
 * Returns models in depth-first order (leaf nodes first)
 *
 * @param graph - The cascade graph
 * @param modelName - The starting model name
 * @returns Array of model names in cascade order
 */
export function getCascadeOrder(
  graph: CascadeGraph,
  modelName: string,
): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(name: string): void {
    if (visited.has(name)) {
      return;
    }
    visited.add(name);

    const children = graph[name];
    if (children !== undefined) {
      for (const child of children) {
        visit(child.model);
      }
    }

    result.push(name);
  }

  visit(modelName);
  return result;
}

/**
 * Gets the direct children of a model in the cascade graph
 */
export function getDirectChildren(
  graph: CascadeGraph,
  modelName: string,
): CascadeChild[] {
  return graph[modelName] ?? [];
}

/**
 * Checks if a model has any cascade children
 */
export function hasCascadeChildren(
  graph: CascadeGraph,
  modelName: string,
): boolean {
  const children = graph[modelName];
  return children !== undefined && children.length > 0;
}

/**
 * Gets all soft-deletable children (direct and indirect) of a model
 */
export function getSoftDeletableDescendants(
  graph: CascadeGraph,
  schema: ParsedSchema,
  modelName: string,
): SoftDeletableModel[] {
  const order = getCascadeOrder(graph, modelName);
  const descendants: SoftDeletableModel[] = [];

  for (const name of order) {
    // Skip the starting model itself
    if (name === modelName) {
      continue;
    }

    const model = schema.modelMap.get(name);
    if (model?.isSoftDeletable === true) {
      descendants.push(model);
    }
  }

  return descendants;
}

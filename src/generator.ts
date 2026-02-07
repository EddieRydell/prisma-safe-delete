import generatorHelper from '@prisma/generator-helper';
const { generatorHandler } = generatorHelper;
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDMMF } from './dmmf-parser.js';
import { buildCascadeGraph } from './cascade-graph.js';
import {
  emitTypes,
  emitRuntime,
  emitCascadeGraph,
  emitIndex,
} from './codegen/index.js';

generatorHandler({
  onManifest(): {
    defaultOutput: string;
    prettyName: string;
    requiresGenerators: string[];
  } {
    return {
      defaultOutput: './generated/soft-cascade',
      prettyName: 'Prisma Soft Cascade',
      requiresGenerators: ['prisma-client-js'],
    };
  },

  async onGenerate(options): Promise<void> {
    const outputDir = options.generator.output?.value;

    if (outputDir === undefined || outputDir === null) {
      throw new Error('No output directory specified for prisma-safe-delete');
    }

    // Parse the DMMF
    const schema = parseDMMF(options.dmmf);

    // Build the cascade graph
    const cascadeGraph = buildCascadeGraph(schema);

    // Generate all output files
    const typesContent = emitTypes(schema);
    const cascadeGraphContent = emitCascadeGraph(cascadeGraph);
    const runtimeContent = emitRuntime(schema);
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

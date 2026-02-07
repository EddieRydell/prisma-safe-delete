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

/**
 * Computes the relative import path from our output directory to the Prisma client.
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

  return relativePath;
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

    // Build the cascade graph
    const cascadeGraph = buildCascadeGraph(schema);

    // Generate all output files
    const typesContent = emitTypes(schema, clientImportPath);
    const cascadeGraphContent = emitCascadeGraph(cascadeGraph);
    const runtimeContent = emitRuntime(schema, clientImportPath);
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

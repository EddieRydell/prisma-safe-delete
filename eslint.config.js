import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { sonarjs },
    rules: {
      // Strictest settings
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',

      // Code quality
      'eqeqeq': ['error', 'always'],
      'no-console': 'error',
      'no-debugger': 'error',

      // Sonarjs — bug detection (not covered by typescript-eslint)
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-duplicated-branches': 'error',
      'sonarjs/no-identical-conditions': 'error',
      'sonarjs/no-identical-expressions': 'error',
      'sonarjs/no-element-overwrite': 'error',
      'sonarjs/no-empty-collection': 'error',
      'sonarjs/no-unused-collection': 'error',
      'sonarjs/no-unthrown-error': 'error',
      'sonarjs/no-useless-increment': 'error',

      // Sonarjs — code quality
      'sonarjs/cognitive-complexity': ['warn', 25],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-alphabetical-sort': 'warn',
      'sonarjs/no-misleading-array-reverse': 'warn',
    },
  },
  // Relaxed rules for test files
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests often need explicit any for mocking
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Return types less important in tests
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // Tests may have non-null assertions for convenience
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Tests may use bracket notation for checking absent properties
      '@typescript-eslint/dot-notation': 'off',
      // Type assertion style preference not important in tests
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      // Allow async without await in mocks
      '@typescript-eslint/require-await': 'off',
    },
  },
  // Code emitter files are inherently high-complexity (branching per model/strategy)
  {
    files: ['src/codegen/emit-runtime.ts'],
    rules: {
      'sonarjs/cognitive-complexity': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.*', 'tests/integration/generated/', 'tests/e2e/generated/', 'tests/e2e-sentinel/generated/', 'tests/e2e-none/generated/', 'tests/e2e-no-cascade/generated/'],
  }
);

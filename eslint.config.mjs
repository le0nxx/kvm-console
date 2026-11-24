import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS = ['src/main/**/*.ts', 'src/preload/**/*.ts'];
const RENDERER = ['src/renderer/*.js'];
const RENDERER_MODULE = ['src/renderer/novnc-app.js'];
const NODE_JS = ['test/**/*.js', 'scripts/**/*.js'];

const scoped = (configs, files) => configs.map((config) => ({ ...config, files }));

export default [
  {
    ignores: ['dist/', 'release/', 'artifacts/', 'node_modules/', 'packaging/', 'build/', '.cache/', 'src/renderer/novnc/'],
  },
  ...scoped([js.configs.recommended, ...tseslint.configs.recommended], TS),
  {
    files: TS,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: RENDERER,
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: RENDERER_MODULE,
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: NODE_JS,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];

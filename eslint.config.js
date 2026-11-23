import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'dist-server', 'dev-dist', 'design', 'playwright-report', 'test-results', 'node_modules', 'docs/mockups'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  { files: ['e2e/**', 'e2e-server/**', 'scripts/**', 'server/**', '*.config.*'], languageOptions: { globals: globals.node } },
  {
    /* Tests read JSON answers whose shape is the thing under test, so they are not typed field by field. */
    files: ['server/test/**', 'e2e-server/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser, sourceType: 'script' } },
);

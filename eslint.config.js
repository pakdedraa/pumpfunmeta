// Flat ESLint config (ESLint 8.57+/9). Focused on catching real bugs, not style.
// `npm run lint` lints both the frontend (src) and the backend (server).
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'server/node_modules/**', '**/*.min.js'],
  },

  // Frontend — browser globals, JSX/React.
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Buffer/process are polyfilled by Vite for the few web3 utils that need them.
      globals: { ...globals.browser, ...globals.es2023, Buffer: 'readonly', process: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // Vite + React 18 automatic runtime
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off', // quotes in copy are fine, not a bug
      // Classic hooks rules only — skip the opinionated react-compiler diagnostics
      // bundled into react-hooks v7 "recommended" (would force a broad refactor).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-useless-escape': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // Backend (Fastify) — Node globals, no React.
  {
    files: ['server/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // Test files — Vitest globals.
  {
    files: ['**/*.test.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];

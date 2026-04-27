const js = require('@eslint/js');
const globals = require('globals');
const prettierRecommended = require('eslint-plugin-prettier/recommended');

module.exports = [
  js.configs.recommended,
  prettierRecommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        chrome: 'readonly'
      }
    },
    rules: {
      'prettier/prettier': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['background/**/*.js'],
    languageOptions: {
      globals: { ...globals.serviceworker }
    }
  },
  {
    files: ['devtools/**/*.js', 'panel/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    ignores: [
      'node_modules/**',
      'vendor/**',
      'dist/**',
      'out/**',
      'eslint.config.js'
    ]
  }
];

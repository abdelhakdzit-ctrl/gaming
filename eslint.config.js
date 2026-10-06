import js from '@eslint/js';
import globals from 'globals';
export default [
  js.configs.recommended,
  { files: ['src/**/*.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }], 'no-empty': 'off', 'no-prototype-builtins': 'off', 'no-self-assign': 'off', 'no-inner-declarations': 'off' } },
  { files: ['scripts/**/*.mjs', 'eslint.config.js', 'vite.config.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } } }
];

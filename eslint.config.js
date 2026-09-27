import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    // Vendored, third-party runtime assets: three.js r165 and the World Shelf
    // scene it drives (public/ is copied verbatim by electron-vite). Neither
    // is ours to restyle, and linting the 1.2 MB three bundle is pure noise.
    ignores: ['src/renderer/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]

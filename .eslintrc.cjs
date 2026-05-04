module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: __dirname },
  plugins: ['@typescript-eslint', 'security'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
  ],
  rules: {
    'no-console': 'warn',                                    // Use logger.ts instead
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    'security/detect-child-process': 'warn',                 // Intentional — see patcher.ts
    'security/detect-non-literal-fs-filename': 'warn',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/unbound-method': 'off',
        'no-console': 'off'
      }
    }
  ]
};

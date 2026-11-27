import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // src-admin holds browser sources with JSX, they are checked by 'npm run check'
        // (tsc against src-admin/tsconfig.json) instead
        ignores: ['src-admin/**/*', 'admin/**/*', 'node_modules/**/*', 'test/**/*', 'build/**/*', 'tmp/**/*', '.**/*'],
    },
    {
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
];

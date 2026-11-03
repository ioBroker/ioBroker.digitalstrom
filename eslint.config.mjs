import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // src-admin holds browser sources with JSX. The rules here are type aware and
        // built for the adapter runtime, they cannot be applied to those files. They are
        // checked by 'npm run check:admin' (tsc against src-admin/tsconfig.json) instead.
        ignores: ['node_modules/**', 'admin/**', 'src-admin/**', '.dev-server/**'],
    },
    {
        files: ['test/**/*.js'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                it: 'readonly',
                before: 'readonly',
                after: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
            },
        },
    },
    {
        rules: {
            // This is a grown JS codebase - keep the legacy callback style valid
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-returns-description': 'off',
            'jsdoc/require-returns-check': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-this-alias': 'off',
            // This project is plain JavaScript that is type checked via JSDoc
            // (tsconfig: allowJs + checkJs). @typedef, @type and @property are therefore
            // not redundant - they ARE the type system here. The rule assumes .ts sources.
            'jsdoc/check-tag-names': ['error', { typed: false }],
            // The DSS JSON API is untyped by nature: "result" carries a different shape for
            // every endpoint. Modelling it as `any` is deliberate, see the DssResponse typedef.
            'jsdoc/reject-any-type': 'off',
        },
    },
];

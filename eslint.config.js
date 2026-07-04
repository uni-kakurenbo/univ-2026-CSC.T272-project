import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginJsonc from "eslint-plugin-jsonc";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        // Global ignores
        ignores: [
            "**/build/**",
            "**/dist/**",
            "**/node_modules/**",
            "**/.tsbuildinfo",
            "**/data/**",
            "apps/agents/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                projectService: {
                    allowDefaultProject: ["scripts/*.ts", "apps/visualizer/vite.config.ts"],
                },
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        plugins: {
            js,
            unicorn: eslintPluginUnicorn,
        },
        rules: {
            "unicorn/no-array-reduce": "off",
            "unicorn/filename-case": [
                "error",
                {
                    cases: {
                        pascalCase: true,
                        camelCase: true,
                    },
                    ignore: [String.raw`vite-env\.d\.ts`],
                },
            ],
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
        },
    },
    // React config for visualizer's client-side files
    {
        files: ["apps/visualizer/src/**/*.{ts,tsx}"],
        plugins: {
            react: reactPlugin,
            "react-hooks": reactHooksPlugin,
        },
        languageOptions: {
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },
        rules: {
            ...reactPlugin.configs.recommended.rules,
            ...reactHooksPlugin.configs.recommended.rules,
            "react/react-in-jsx-scope": "off",
            // This app intentionally derives/resets state from props in effects
            // (video-like playback sync); the React Compiler heuristic doesn't fit.
            "react-hooks/set-state-in-effect": "off",
        },
        settings: {
            react: {
                version: "detect",
            },
        },
    },
    // JSON config
    {
        files: ["**/*.json", "**/*.jsonc"],
        plugins: {
            jsonc: eslintPluginJsonc,
        },
    },
    ...eslintPluginJsonc.configs["flat/prettier"],
    eslintConfigPrettier
);

/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_SERVER_ORIGIN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

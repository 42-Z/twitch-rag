/// <reference types="vite/client" />

// Значения, которые сборка закладывает в страницу (https://vite.dev/guide/env-and-mode).
interface ImportMetaEnv {
  readonly VITE_REGISTRY_URL?: string;
  readonly VITE_REGISTRY_READONLY_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

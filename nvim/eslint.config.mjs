import vueTsEsLintConfig from "@vue/eslint-config-typescript";
import prettierConfig from "@vue/eslint-config-prettier";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default [
  {
    ignores: ["**/dist/**/*"],
  },
  prettierConfig,
  ...vueTsEsLintConfig({ rootDir }),
];

import vueTsEsLintConfig from "@vue/eslint-config-typescript";
import prettierConfig from "@vue/eslint-config-prettier";

export default [
  {
    files: ["**/*.ts"],
    rules: {
      "no-unused-vars": "error",
      "no-undef": "error",
    },
  },
  prettierConfig,
  ...vueTsEsLintConfig(),
];

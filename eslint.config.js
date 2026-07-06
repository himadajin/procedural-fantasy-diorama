// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  ...tseslint.configs.recommended,
  {
    // 生成パイプラインは Three.js 非依存(docs/internal/contracts/pipeline.md)
    files: ["src/rng/**", "src/model/**", "src/pipeline/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "three",
              message:
                "rng/model/pipeline は Three.js 非依存の純関数群とする(contracts/pipeline.md)",
            },
          ],
          patterns: ["three/*"],
        },
      ],
    },
  },
);

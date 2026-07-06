/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    environment: "node",
    // 生成パイプライン全段を通すテスト(wards / plazas 等)は 1 ケースで
    // 複数回の生成を行うため、既定の 5s では並列実行時に足りない
    testTimeout: 60000,
  },
});

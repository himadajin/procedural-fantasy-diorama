/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages のプロジェクトページはサブパス(/<repo>/)で配信されるため、
  // アセット参照を相対パスにする。リポジトリ名に依存せず、リネーム・フォーク・
  // カスタムドメイン・ユーザーページのいずれでも設定変更なしで動く。
  // 単一ページ+クエリパラメータのみ(ルーティングなし)のため相対 base で破綻しない。
  base: "./",
  test: {
    environment: "node",
    // 生成パイプライン全段を通すテスト(wards / plazas 等)は 1 ケースで
    // 複数回の生成を行うため、既定の 5s では並列実行時に足りない
    testTimeout: 60000,
  },
});

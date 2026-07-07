# procedural-fantasy-diorama

剣と魔法の異世界を思わせるファンタジー建築の箱庭を、
seed と 6 つの高レベルパラメータから自動生成するブラウザ向け 3D アプリ。
Vite + TypeScript + Three.js。生成は決定論的で、
同じ seed と同じパラメータからは同じ箱庭が再現される。

## 起動

```sh
npm install
npm run dev
```

その他のコマンド: `npm test` / `npm run typecheck` / `npm run lint` / `npm run build`

## ドキュメント

- 利用ガイド(操作・パラメータの意味): [docs/user/README.md](docs/user/README.md)
- 内部仕様(何であるか / どう見えるか / どう作るか):
  [docs/internal/specs/](docs/internal/specs/)
- データ契約(WorldModel・パイプライン): [docs/internal/contracts/](docs/internal/contracts/)
- 実装計画・検証記録: [docs/internal/plans/](docs/internal/plans/)

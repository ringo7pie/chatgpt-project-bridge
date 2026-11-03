# chatgpt-project-bridge 現在状態

## 現在状態（CURATED）

2.10.1（2026-11-03）。2.10.0 で `start_claude_job` に `model`・`effort` を足し、2.10.1 で GitHub での公開のための整備（英語の README・LICENSE・CI・文書の匿名化）をした。ツールはハブで 31 個。

## 課題・リスク・相談事項（CURATED）

- サーバーは要求を 1 件ずつ処理するので、重い検索の間は他の要求が待たされる。
- `find_references` は文字列の一致で、言語の解析はしない。
- Windows の承認ファイルの ACL は検査しない。

## 次の作業（CURATED）

- 要求の並行処理、言語を理解する参照検索、署名つきの Bundle の公開を検討する。

<!-- AUTO:BEGIN git -->
## Git自動収集

- 未収集（`Update` を実行すると、ここに現在のブランチ・HEAD・作業ツリーの状態が入る）
<!-- AUTO:END git -->

# MornGeminiRelay

Gemini (gemini.google.com) に投げた質問を Discord Webhook へ転送し、履歴を Markdown でダウンロードする Chrome 拡張。

## インストール

1. `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」でこのディレクトリを選ぶ
2. ツールバーのアイコンから Webhook URL を入力して保存

## 動作

- 送信 (Enter / 送信ボタン) の瞬間に入力欄 `.ql-editor` のテキストを取り、`chrome.storage.local` に保存 + Webhook へ POST
- 「履歴を .md でダウンロード」で全件を Markdown 出力

## 過去履歴の取り込み

Gemini のタブを開いた状態でポップアップの「過去履歴を全取り込み」を押す。
サイドバーの会話 URL をキューに保存し、1 会話ずつページ遷移で開いて `user-query` を収集する (URL + 本文で重複排除)。取り込み中はそのタブを触らない。
会話ごとの送信日時は DOM に無いため、取り込み分は日時なし。

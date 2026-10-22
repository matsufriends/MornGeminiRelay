# Chrome ウェブストア掲載内容

名称：MornGeminiRelay
言語：日本語
カテゴリ：仕事効率化
単一の目的：Gemini の会話を Slack で共有し、質問履歴を保存する。

## 説明文

Gemini の質問・回答・生成コードを、指定した Slack チャンネルの会話別スレッドへ転送します。

・質問を送信すると自動転送。回答も同じスレッドへ投稿します。
・ユーザーは 👤、Gemini は 🤖、コード・Canvas の添付は 📎 で区別します。
・取得できた Canvas HTML はファイルとして添付し、更新を検知すると再添付します。
・過去の会話を選んで Slack に送信できます。
・自分の質問履歴を会話ごとの Markdown ファイルとして保存できます。

利用には Gemini へのログインと、ご自身で用意した Slack App が必要です。Slack App に chat:write、files:write、chat:write.customize を付与し、投稿先チャンネルに招待してください。拡張の設定に Bot Token とチャンネル ID を入力し、転送への同意にチェックして保存すると転送が始まります。初期状態では転送しません。

質問・回答・生成コードなどは指定した Slack チャンネルに共有されます。機密情報を扱う場合は送信先と利用権限をご確認ください。ユーザーが添付したファイルは名前のみ転送します。Gemini の画面変更や読み込み状況により、会話や Canvas を取得できない場合があります。

Google・Gemini・Slack の公式製品ではありません。

## Privacy practices の回答用

- storage：Token・設定・会話とスレッドの対応、セッション中の会話一覧と処理状況を保存する。
- downloads：利用者の操作で質問履歴を Markdown として端末に保存する。
- slack.com/api：設定された Token で Slack の投稿・ファイル共有 API を呼び出す。
- files.slack.com：Slack が発行したアップロード先へ生成コード・Canvas HTML を送信する。
- gemini.google.com：質問・回答・会話一覧・表示名を読み取り、利用者の操作で履歴を取得する。
- *.scf.usercontent.goog：Gemini Canvas プレビューの HTML を取得する。取得した HTML はコード実行せず、Slack 添付として送る。
- リモートコード：使用しない。拡張の実行コードは ZIP 内に同梱。Gemini のページ自身が実行するコードは拡張コードではない。
- データの使用：個人を特定できる情報（表示名）、認証情報（Slack Bot Token）、個人的コミュニケーション（会話）、ウェブサイトのコンテンツ（会話・生成コード・Canvas）。実際のフォーム項目と照合して選択する。
- 売却なし、単一目的以外の使用・転送なし、信用力・融資判断への使用なし。宣誓は最終的に公開者自身が内容を確認する。
- プライバシーポリシー：https://github.com/matsufriends/MornGeminiRelay/blob/master/privacy.html （GitHub 上の公開文書）。必要に応じて同じ内容を Web ページとしてホスティングする。
- サポート：https://github.com/matsufriends/MornGeminiRelay/issues

## 審査担当者向け手順

1. Gemini にログインする。
2. ご自身の Slack テスト用ワークスペースで App を作成し、上記 3 スコープを付与してインストール、チャンネルに招待する。
3. 拡張の設定に Bot Token とチャンネル ID を入力。転送に同意して保存する。
4. Gemini で新規会話に質問し、Slack に質問と回答が同じスレッドで届くことを確認する。
5. コード生成を依頼すると、取得できたコードが同じスレッドに添付される。
6. Token がなくても「Gemini を開いて履歴を保存」は利用可能。保存対象は自分の質問のみ。

公開者の Token・アカウント情報を審査メモに記載しない。

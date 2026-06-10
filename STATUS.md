# ShotComfy — 進捗・状況メモ

> このファイルは「いま何ができていて、何が途中/未確認か」の早見表です。
> 技術的な詳細は [DEVLOG.md](./DEVLOG.md)、使い方は [README.md](./README.md) / [SETUP.md](./SETUP.md)。

- 最終更新: 2026-06-10
- 最新コミット: `30e309e`（GitHub に push 済み）
- リポジトリ: https://github.com/kaki373/ShotComfy
- 状態: 作業ツリーはクリーン（未コミットの変更なし）。要望分はすべて実装・GitHub反映済み。

---

## ✅ 完了している機能（GitHubに反映済み）

**基盤（v1）**
- React Flow キャンバスで 素材を プロジェクト→話数→カット 単位に表示
- メタデータからの系統（lineage）ツリー、出自カラー、手動タグ（OK/属性）
- 2画像のA/B比較、フォルダツリー、Free/Projectモード

**ComfyUI ジョブ投入（i2i / V2V）**
- ジョブビルダー（▶ ComfyUIで生成）：選択画像→スロット割当→投入
  - スロット＝`LoadImage`/動画ローダーの **ノードタイトル**で識別（`入力1`/`input1`/`Input_1` など表記ブレOK）
  - 「枚数（=画像入力スロット数）」は **自動**、ジョブ×スロットのプレビュー
- 出力は **入力ファイル名＋`_gen<世代>`**（`foo→foo_gen1`、孫は`foo_gen2`）でカットフォルダへ
- **保存ノード（SaveImage / VHS_VideoCombine）の出力だけ**コピー（Preview等のtempは無視）

**ワークフロー管理**
- **UI形式の `.json` を置くと自動でAPI形式に変換**（ComfyUI本体の graphToPrompt をブリッジ経由で利用→`<名前>_api.json` 生成）
- **ComfyUI由来PNGからワークフロー抽出**（右クリック→workflowsへ `prompt`/`workflow` を保存）
- ワークフロー行に「📁フォルダを開く」「⟳更新」ボタン

**右クリックのファイル操作**
- 複製 / 名前変更 / **JPG・PNG変換（PSD/PSB対応）** / **動画の先頭・末尾フレーム→PNG**（同梱ffmpeg）
- **フォルダへ移動**（フォルダツリーのピッカー）/ **🗄 old に送る**（各フォルダ直下の `old/` へ退避＝復元可）/ **🗑 完全に削除**（確認あり）
- **Delキーで old に送る → Ctrl+Z で戻す**（メモリ上のundoスタック）
- 左ツリー：フォルダ作成、old に送る、完全に削除、**ルートのみ「old を一括削除」**

**ビューア**
- 比較ウインドウ＆1枚ダブルクリックのライトボックスに **全画面＋ホイールズーム＋ドラッグ移動**、ライトボックスは **←/→で前後の画像へ**

**UX**
- 左上トグル・間隔スライダの状態を **localStorage に保存（再起動後も復元）**
- 長いファイル名は **中央省略**（拡張子・`_gen`等の末尾を残す）、🔄手動更新ボタン

---

## 🖥 再開（起動）方法

| 役割 | 場所 / コマンド | ポート |
|---|---|---|
| バックエンド | `D:\webui\ShotComfy\backend` で `./.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8799` | 8799 |
| フロント | `D:\webui\ShotComfy\frontend` で `npm run dev` | 5273（strictPort） |
| ComfyUI | `D:\webui\ComfyUI\run_nvidia_gpu.bat`（通常起動） | 8188 |

- ブラウザで `http://127.0.0.1:5273/` を開く。
- ワークフローのAPI自動変換を使う時は **ComfyUIのブラウザタブを開いておく**（変換器がブラウザ側で動くため）。
- 別PCへは **リポジトリをコピー → `backend` で pip、`frontend` で npm install** で再構築（venv/node_modules はコピー不要）。

---

## ⚠️ 中断中 / 未確認 / 要対応

1. **実ジョブの本番通し確認が未完**
   - テストした `flux_i2i` は **ワークフロー自体に不備**：`ResizeImagesByShorterEdge`(node 259) の `images` 入力が未接続 → ComfyUIが弾く（ShotComfyのバグではない）。
   - 対応：ComfyUIで `flux_i2i` を開き、node 259 の入力を接続 or 削除 → 保存 → ShotComfyで再投入（古い `_api` は自動で作り直し）。
2. **V2V（動画）スロットのアップロード経路が未検証**：画像のアップロードはOK。動画スロットは現状 `/upload/image` 経由で、実V2Vワークフローでの動作は要確認。
3. **過去のデータ消失（注意喚起）**：ネットワークドライブX:にはゴミ箱が無く、旧「削除」(`send2trash`)が**完全削除**になっていた。現在は撤去し「old に送る」方式に変更済み。**それ以前にツールで削除したファイルは消えている可能性** → 必要ならファイルサーバのスナップショット/以前のバージョンで復旧を。
4. **Codex によるコードレビュー**：未実施（Wi-Fi経由の codex ラッパー前提）。

---

## 📌 注意点

- `backend/.venv` には **ffmpeg 同梱（約84MB）**。`.gitignore` 済みなので push されない。
- **素材（PNG/MP4/PSD等）は Git に入れない**（100MB超は GitHub が拒否）。素材は X: に置く運用。
- 自動生成キャッシュ `workflows/*_api.json` も `.gitignore` 済み（ソースの `.json` から再生成される）。
- ComfyUIブリッジは `D:\webui\ComfyUI\ComfyUI\custom_nodes\shotcomfy_bridge\` に設置済み。ルート変更後の Python ルート反映には ComfyUI 再起動が必要（確認済み）。

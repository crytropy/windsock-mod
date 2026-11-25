# windsock-mod
用量資訊列

輸入框上方的一列資訊：左邊是用量（Context、5 小時、Fable 每週、每週），右邊是目前分支的 PR 狀態，和主對話 1 小時快取的倒數。

```text
☂ Showers 67%  134.4k/200k  ▲ +98.3k   ·   5h 30% (resets in 2h10m)   ·   Fable 23%   ·   Week 12%     ✓ PR #12   ·   52:13
```

Context 用天氣表示有多滿，後面是用掉的 token／整個視窗，和上一輪多用了多少（▲ 變多、▼ 變少）。終端機太窄時，▲ 那段會先藏起來。

壓縮對話（`/compact` 或自動壓縮）完成時，Context 會馬上降下來。這時 Claude Code 還沒有新的實際數字，所以先顯示本機估算值（和 `/context` 的估法相同）。下一輪回應後，再換成實際數字。

`Fable` 是 Fable 這個模型自己的每週用量。session 的用量資料裡沒有這個數字，所以外掛會用目前登入的帳號去讀 `/api/oauth/usage`（和 `/usage` 看到的是同一份），最多每 5 分鐘讀一次。帳號沒有 Fable 的每週額度、用的是 API key 或第三方供應商，這一段就不顯示。

| 用量 | 天氣 |
|---|---|
| 未滿 25% | ☀ Clear |
| 25–49% | ☁ Cloudy |
| 50–74% | ☂ Showers |
| 75–89% | ☇ Storm |
| 90% 以上 | ↯ Compact soon |

Context 的天氣顯示參考 Anthropic 的 [Token Weather](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather)（Apache-2.0）。

## PR 狀態

右邊、倒數的左邊，是目前分支的 PR（換分支後還開著的前一個 PR 也會留著，見下面「換分支後」）。只顯示四種狀態，其他情況（沒有 PR、草稿、CI 失敗、有衝突、已關閉）不顯示。

| 圖示 | 意思 |
|---|---|
| `◐ PR #12`（黃） | CI 正在跑，或剛推送、CI 還沒開始、GitHub 還在判斷能不能合併 |
| `✓ PR #12`（綠） | CI 過了，可以合併。PR 沒有設任何 CI 時，能合併就算過（但推送後 5 分鐘內先顯示 `◐`，因為 GitHub 開 PR 後要幾秒才掛上 CI） |
| `⧗ PR #12`（藍） | 在 merge queue 裡排隊等合併。排隊時每分鐘更新一次 |
| `● PR #12`（紫） | 已合併 |

`PR #12` 是連結，點了會開 PR 的網頁（終端機通常要按住 Ctrl 或 Cmd 再點）。不支援連結的終端機會把網址直接印在後面。

### 換分支後

開完 PR 就換到下一個分支時，前一個 PR 不會消失：這個 session 看過、還開著的 PR 都會留著，直到合併或關掉。目前分支的 PR 排最前面，其他的照新到舊排在後面，最多記 5 個。

```
☂ Showers 67%  ·  Week 12%     ◐ PR #13   ·   ✓ PR #12   ·   52:13
```

留著的 PR 一樣只顯示上面三種狀態；CI 失敗、有衝突、變回草稿時先不顯示，但會繼續追，修好了就再出現。合併或關掉後就拿掉（目前分支自己的 PR 合併後還是顯示 `●`）。

### 不在分支上時

repo 停在某個 commit、沒掛在任何分支上（detached HEAD）時，`gh pr view` 不知道要問哪個分支。這時會改問「指向同一個 commit 的本機分支」的 PR：用 `git for-each-ref --points-at HEAD` 找分支，最多問 5 個，顯示第一個有 PR 的。沒有分支指向這個 commit 時，這個 session 之前看過、還開著的 PR 照樣留著。

### 從別的資料夾推送時

session 的資料夾停在 `main`，Claude 卻在另一個 worktree 裡 commit、推送、開 PR 時，`gh pr view` 問的是 `main`，找不到那個 PR。所以 Claude 跑完指令後，會看 Claude Code 對這個指令的解讀（推到哪個分支、開了或改了哪個 PR）：

- 開了、改了 PR（`gh pr create`、`gh pr ready`、`gh pr edit` 等）：直接記下這個 PR。
- 推到某個分支：用 `gh pr view <分支>` 問那個分支的 PR，還開著就記下來。

記下來的 PR 和「換分支後」留著的 PR 一樣，追到合併或關掉為止。在別人的 PR 留言（`gh pr comment`）不會記。

### 多久讀一次

狀態是用本機的 [`gh`](https://cli.github.com/) 讀的（`gh pr view`），所以要先裝好 `gh` 並登入；沒裝或沒登入，這一段就不顯示。每輪對話結束時會讀一次（最多每分鐘一次）；閒置時 CI 還在跑就每分鐘讀一次，否則每 5 分鐘讀一次。留著的 PR 每次一起讀，一個 PR 跑一次 `gh pr view <網址>`。

Claude 用 Bash 或 PowerShell 跑完 `git push`、`gh pr create`、`gh pr ready`、`gh pr reopen`，或其他推送、開 PR 的指令後會馬上讀一次，之後 5 分鐘內每分鐘讀一次，等 CI 開始跑。`gh` 一時連不上（網路、GitHub 暫時出錯）時保留上一次的狀態，不會突然消失。

## 快取倒數

最右邊是主對話 1 小時快取還剩多久，只顯示時間（`52:13`）。主對話每送出一次請求就重新從 60:00 算起。

| 剩餘時間 | 樣子 |
|---|---|
| 超過 5 分鐘 | 灰色 |
| 5 分鐘以內 | 黃色，並跳一次通知 |
| 1 分鐘以內 | 紅色 |
| 時間到 | 停在紅色的 `00:00` |

## 兩個版本

| 版本 | 給誰用 | 左邊顯示 |
|---|---|---|
| `windsock-mod` | Pro、Max | Context、5 小時、Fable 每週、每週 |
| `windsock-mod-ultra` | Ultra（沒有 5 小時限制） | Context、Fable 每週、每週 |

右邊的 PR 狀態和快取倒數，兩個版本都一樣。

```text
☂ Showers 67%  134.4k/200k  ▲ +98.3k   ·   Fable 23%   ·   Week 12%     ✓ PR #12   ·   52:13
```

Ultra 帳號在驗證完成前，用量裡還是會有 5 小時的數字；`windsock-mod-ultra` 一律不顯示。

兩個版本只能裝一個，同時啟用會畫出兩列。

## 安裝（本機）

先加 marketplace：

```
/plugin marketplace add crytropy/windsock-mod
```

再開 `/plugin`，到 `windsock-mod` marketplace 裡挑一個版本安裝。也可以直接下指令：

```
/plugin install windsock-mod@windsock-mod
/plugin install windsock-mod-ultra@windsock-mod
```

從一般版換成 Ultra 版：

```
/plugin uninstall windsock-mod@windsock-mod
/plugin install windsock-mod-ultra@windsock-mod
```

要讓某個 repo 在本機開的 session 自動載入，在那個 repo 的 `.claude/settings.json` 加上：

```json
{
  "extraKnownMarketplaces": {
    "windsock-mod": { "source": { "source": "github", "repo": "crytropy/windsock-mod" } }
  },
  "enabledPlugins": { "windsock-mod@windsock-mod": true }
}
```

這段設定只對本機 session 有效。雲端 session 不會安裝 repo 設定或使用者設定裡的外掛，見官方文件 [What carries over from your setup](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup)。

## 更新日誌

| 版本 | 日期 | 內容 |
| --- | --- | --- |
| 0.3.6 | 2026-11-25 | PR 狀態：PR 在 merge queue 排隊時顯示 `⧗` |
| 0.3.5 | 2026-11-20 | Context：壓縮對話後馬上更新，不用等下一輪回應 |
| 0.3.4 | 2026-11-20 | PR 狀態：session 資料夾停在 `main`、在別的 worktree 推送或開 PR 時，PR 也會顯示 |
| 0.3.3 | 2026-11-18 | PR 狀態：沒掛在分支上（detached HEAD）時，改問指向同一個 commit 的本機分支 |
| 0.3.2 | 2026-11-16 | PR 狀態：換分支後，還開著的 PR 留在資訊列上；剛推送、還沒有 CI 時不顯示綠色 |
| 0.3.1 | 2026-11-16 | PR 狀態：推送、開 PR 後馬上讀一次；`gh` 一時失敗時保留上一次的狀態 |
| 0.3.0 | 2026-11-13 | 加上可點開的 PR 狀態；快取倒數只留時間。11-14 專案從 prompt-band 改名為 windsock-mod |
| 0.2.0 | 2026-11-12 | 加上 Fable 每週用量，拉開各段的間距 |
| 0.1.5 | 2026-11-02 | 新增 Ultra 版：沒有 5 小時限制 |
| 0.1.4 | 2026-11-01 | Context 改用 Token Weather 天氣顯示 |
| 0.1.3 | 2026-10-18 | 快取過期時只顯示「快取已過期」 |
| 0.1.2 | 2026-10-17 | 第一版（prompt-band）：左邊是用量（Context、5 小時、每週），右邊是主對話 1 小時快取的倒數 |

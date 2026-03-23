import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { execSync } from 'child_process';

const CONFIG_PATH = path.join(os.homedir(), '.ask-geminirc.json');
const LOG_PATH = path.join(process.cwd(), '.ask-gemini-log.json');

// SVGはテキストフォーマットのためGeminiに読ませる（コンポーネント設計の把握に役立つ場合があるため除外しない）
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.ttf', '.woff', '.woff2', '.eot', '.apk', '.jar', '.pdf', '.zip', '.mp3', '.mp4', '.mov']);
const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

// =====================
// ログ出力ユーティリティ
// =====================
function writeLog(entry) {
  let log = [];
  try {
    if (fs.existsSync(LOG_PATH)) {
      log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
    }
  } catch (e) {
    // ログファイルが壊れていても続行
  }
  log.push({ timestamp: new Date().toISOString(), ...entry });
  try {
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  } catch (e) {
    process.stderr.write(`[WARNING] ログの書き込みに失敗しました: ${e.message}\n`);
  }
}

function showHelp() {
  console.log(`
【 ask-gemini.mjs (AIオーケストレーション・プロキシツール) v2 】
Gemini 1.5 Pro の大容量コンテキストと言語/視覚のマルチモーダル能力を活用します。
plan作成を2段階に分けることで、1回の失敗が致命傷にならない設計です。

使用方法:
  node ask-gemini.mjs "[プロンプト]" [オプション]

オプション:
  --help, -h          このヘルプを表示して終了します。
  --reset-key         保存されている API キーを削除・再設定します。
  --attach <パス>     画像やPDFなどの添付ファイルを指定します（複数指定可）。
                      指定されたファイルはBase64化され、Geminiの視覚機能で解析されます。

実例:
  node ask-gemini.mjs "カレンダーコンポーネントの表示崩れを治して"
  node ask-gemini.mjs "この画像のズレを直して" --attach "C:/path/to/error.png"
  node ask-gemini.mjs --reset-key
`);
  process.exit(0);
}

function askQuestion(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resetApiKey() {
  console.log('--- APIキーの再設定 ---');
  const newKey = await askQuestion('新しい Gemini API キーを入力してください: ');
  if (!newKey) {
    console.error('APIキーが入力されませんでした。処理を中止します。');
    process.exit(1);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ GEMINI_API_KEY: newKey }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log('✅ 新しいAPIキーを保存しました！');
  process.exit(0);
}

async function getApiKey() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (config.GEMINI_API_KEY) return config.GEMINI_API_KEY;
    } catch (e) {
      console.error('[Error] 設定ファイルの読み込みに失敗しました。', e.message);
    }
  }

  const newKey = await askQuestion('Gemini API キーを入力してください: ');
  if (!newKey) {
    console.error('APIキーが入力されませんでした。処理を中止します。');
    process.exit(1);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ GEMINI_API_KEY: newKey }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
  return newKey;
}

// =====================
// 初回セットアップ
// =====================
function isFirstRun() {
  const excludePath = path.join(process.cwd(), '.git', 'info', 'exclude');
  try {
    if (fs.existsSync(excludePath)) {
      return !fs.readFileSync(excludePath, 'utf-8').includes('ask-gemini.mjs');
    }
    return fs.existsSync(path.join(process.cwd(), '.git'));
  } catch (e) {
    return false;
  }
}

async function runSetup() {
  console.log(`
[初回セットアップ] 以下の処理を行います：
  1. Gemini API キーを ~/.ask-geminirc.json に保存 (パーミッション 0o600)
  2. ask-gemini.mjs と .ask-gemini-log.json を .git/info/exclude に追記
     （これらのファイルをプロジェクトの git 管理対象から除外します）

  claude.md への統合（任意・後ほど個別に確認）:
  3. Claude_ask-gemini.md の内容を claude.md に追記します
     ※ claude.md が存在する場合は末尾に追記、存在しない場合は新規作成
`);

  const answer = await askQuestion('続行しますか？ [Y/n]: ');
  if (answer.toLowerCase() === 'n') {
    console.log('[セットアップをスキップしました。手動でセットアップする場合は README を参照してください。]\n');
    return null;
  }

  // Step 1: APIキー
  let apiKey = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (config.GEMINI_API_KEY) {
        apiKey = config.GEMINI_API_KEY;
        console.log('  [1/3] ✅ Gemini API キーは既に保存されています。');
      }
    } catch (e) { /* 読み込み失敗時は再入力へ */ }
  }
  if (!apiKey) {
    const key = await askQuestion('  [1/3] Gemini API キーを入力してください: ');
    if (!key) {
      console.error('APIキーが入力されませんでした。処理を中止します。');
      process.exit(1);
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ GEMINI_API_KEY: key }, null, 2));
    fs.chmodSync(CONFIG_PATH, 0o600);
    apiKey = key;
    console.log('  ✅ APIキーを保存しました。');
  }

  // Step 2: .git/info/exclude
  const excludePath = path.join(process.cwd(), '.git', 'info', 'exclude');
  try {
    const excludeDir = path.dirname(excludePath);
    if (!fs.existsSync(excludeDir)) fs.mkdirSync(excludeDir, { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    const toAdd = ['ask-gemini.mjs', '.ask-gemini-log.json', 'Claude_ask-gemini.md']
      .filter(entry => !existing.includes(entry));
    if (toAdd.length > 0) {
      fs.appendFileSync(excludePath, '\n# ask-gemini\n' + toAdd.join('\n') + '\n');
    }
    console.log('  [2/3] ✅ .git/info/exclude に追記しました。');
  } catch (e) {
    process.stderr.write(`  [WARNING] .git/info/exclude の更新に失敗しました: ${e.message}\n`);
  }

  // Step 3: claude.md への統合（任意）
  const claudeAskGeminiPath = path.join(process.cwd(), 'Claude_ask-gemini.md');
  if (fs.existsSync(claudeAskGeminiPath)) {
    const claudeMdPath = path.join(process.cwd(), 'claude.md');
    const claudeMdExists = fs.existsSync(claudeMdPath);
    const action = claudeMdExists ? '末尾に追記' : '新規作成';
    const answer3 = await askQuestion(`  [3/3] Claude_ask-gemini.md を claude.md に${action}しますか？ [Y/n]: `);
    if (answer3.toLowerCase() !== 'n') {
      try {
        const content = fs.readFileSync(claudeAskGeminiPath, 'utf-8');
        fs.appendFileSync(claudeMdPath, (claudeMdExists ? '\n' : '') + content);
        console.log(`  ✅ claude.md に${action}しました。`);
      } catch (e) {
        process.stderr.write(`  [WARNING] claude.md の更新に失敗しました: ${e.message}\n`);
      }
    } else {
      console.log('  [スキップ] claude.md への追記をスキップしました。');
    }
  } else {
    console.log('  [3/3] Claude_ask-gemini.md が見つからないためスキップしました。');
  }

  console.log('\n✅ セットアップ完了！\n');
  return apiKey;
}

// MIMEタイプを判定するヘルパー
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

// フォールバックメッセージ（共通化）
const FALLBACK_MESSAGE = `[WARNING] Gemini API Limit Reached. 分析マップの作成に失敗しました。
以下の制約と順序に従って対処してください：
1. 指定のタスクを単独で解決可能か、あなた自身（Claude Code）のツール（個別探索と読み込み）を用いて試みてください。
2. その際、トークン上限超過や暴走を防ぐため、「巨大ソース（全ファイル）の無差別・一括読み込み」は絶対に実行しないでください。
3. もしエラーが連続した場合や、自律解決が困難・複雑すぎると判断した場合は、推測で強行せず直ちに作業を中断し、人間のユーザーに状況を報告（フォールバック）して判断を仰いでください。`;

// =====================
// Gemini API呼び出し（共通）
// =====================
async function callGemini(apiKey, systemInstruction, parts) {
  const requestBody = {
    contents: [{ parts }],
    systemInstruction: { parts: [{ text: systemInstruction }] }
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    const err = { status: response.status, statusText: response.statusText };
    if (response.status === 429 || response.status >= 500) {
      err.fallback = true;
    } else {
      err.body = await response.text();
    }
    throw err;
  }

  const data = await response.json();
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('空レスポンス: ' + JSON.stringify(data));
  }
  return {
    text: data.candidates[0].content.parts[0].text,
    usage: data.usageMetadata ?? {}
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args.includes('/help')) {
    showHelp();
  }

  if (args.includes('--reset-key') || args.includes('/reset-key')) {
    await resetApiKey();
  }

  // 引数のパース（プロンプト文字列と添付ファイルの分離）
  let userPromptArgs = [];
  let attachments = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--attach' && i + 1 < args.length) {
      attachments.push(args[i + 1]);
      i++;
    } else {
      userPromptArgs.push(args[i]);
    }
  }

  // オプションフラグ（--xxx や /xxx）をuserPromptから除外する
  const userPrompt = userPromptArgs.filter(a => !a.startsWith('--') && !a.startsWith('/')).join(' ');

  let apiKey;
  if (isFirstRun()) {
    const setupResult = await runSetup();
    apiKey = setupResult ?? await getApiKey();
  } else {
    apiKey = await getApiKey();
  }

  // 1. Gitの管理対象ファイルをすべて取得
  let files = [];
  try {
    const output = execSync('git ls-files', { encoding: 'utf-8' });
    files = output.split('\n').filter(Boolean);
  } catch (e) {
    console.error('[Error] git ls-files の実行に失敗しました。Gitリポジトリのルート内で実行してください。');
    process.exit(1);
  }

  // 2. 結合ソースの作成（情報ダイエット）
  let codebaseContext = '';
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const basename = path.basename(file);

    if (BINARY_EXTS.has(ext) || IGNORED_FILES.has(basename)) {
      continue;
    }

    try {
      const content = fs.readFileSync(file, 'utf-8');
      codebaseContext += `\n--- File: ${file} ---\n${content}\n`;
    } catch (e) {
      // 読み込めないファイルはスキップするがstderrに記録する
      process.stderr.write(`[SKIP] ${file}: ${e.message}\n`);
    }
  }

  // 添付ファイルの処理（マルチモーダル・Step1のみに添付）
  let attachParts = [];
  for (const attachmentPath of attachments) {
    try {
      if (fs.existsSync(attachmentPath)) {
        // サイズチェック（10MB超はAPIエラーになるためスキップ）
        const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
        const stat = fs.statSync(attachmentPath);
        if (stat.size > MAX_ATTACH_BYTES) {
          process.stderr.write(`[WARNING] 添付ファイルが大きすぎます(${Math.round(stat.size / 1024 / 1024)}MB)。スキップします: ${attachmentPath}\n`);
          continue;
        }
        const mimeType = getMimeType(attachmentPath);
        const data = fs.readFileSync(attachmentPath).toString('base64');
        attachParts.push({ inlineData: { mimeType, data } });
      } else {
        process.stderr.write(`[WARNING] 指定された添付ファイルが見つかりません: ${attachmentPath}\n`);
      }
    } catch (e) {
      process.stderr.write(`[WARNING] 添付ファイルの読み込みに失敗しました (${attachmentPath}): ${e.message}\n`);
    }
  }

  // =====================
  // Step 1: 対象ファイル特定 + 依存関係マップ
  // =====================
  process.stderr.write('[Step 1/2] 対象ファイルと依存関係を特定中...\n');

  const step1SystemInstruction = `
あなたは世界最高峰のソフトウェアエンジニアです。
以下のプロジェクト全ソースコードを俯瞰し、ユーザーの要求を実現するために
「どのファイルが関係するか」と「それらの依存関係」だけを特定してください。

【出力フォーマット（厳守）】
## 対象ファイル
- path/to/file.ts (変更対象)
- path/to/other.ts (参照のみ)

## 依存関係マップ
- file.ts → other.ts（理由: ○○を参照しているため）

## 修正の影響範囲
（変更が波及しうる箇所を簡潔に記述）

コードの修正手順はまだ書かないこと。ファイル特定と依存関係の把握のみ。
`;

  const step1Prompt = `
【ユーザーの要求】
${userPrompt}

【プロジェクトの全ソースコード】
${codebaseContext}
`;

  // コードベース全体の推定トークン数（ask-gemini を使わず Claude に直接渡した場合の比較基準）
  const baselineTokens = Math.round(codebaseContext.length / 4);

  let step1Result = '';
  let step1Usage = {};
  try {
    const res1 = await callGemini(apiKey, step1SystemInstruction, [{ text: step1Prompt }, ...attachParts]);
    step1Result = res1.text;
    step1Usage = res1.usage;
    writeLog({ step: 1, status: 'success', prompt: userPrompt, result: step1Result, geminiUsage: step1Usage });
    process.stderr.write('[Step 1/2] 完了。\n');
  } catch (err) {
    writeLog({ step: 1, status: 'error', error: err.message || err });
    if (err.fallback) {
      console.log(FALLBACK_MESSAGE);
      process.exit(0);
    }
    console.error(`[Error] Step1 失敗: ${err.body || err.message || JSON.stringify(err)}`);
    process.exit(1);
  }

  // =====================
  // Step 2: 詳細修正手順 + Verification Section（必須）
  // =====================
  process.stderr.write('[Step 2/2] 詳細な手術計画書を生成中...\n');

  const step2SystemInstruction = `
あなたは世界最高峰のソフトウェアエンジニアです。
Step1で特定されたファイルと依存関係をもとに、Claude Codeが実行できる
「具体的な手術計画書（Surgery Plan）」を作成してください。

【出力フォーマット（厳守）】

# Surgical Plan: [タスク名]

## 1. Context & Objective
[変更の目的と背景を簡潔に]

## 2. Target Files & Dependencies
[Step1の結果をもとにリスト化]
- \`path/to/file.ts\` (Target)
- \`path/to/other.ts\` (Read-only Reference)

## 3. Step-by-Step Execution Plan
[Claudeがそのまま順次実行できるタスクリスト]
### Step 3.1: [ファイル名]
- **Focus**: [変更箇所]
- **Action**: [具体的な変更内容]
- **Constraints**: [守るべき制約]

## 4. Verification & Testing
【重要・必須】このセクションが空または未記載の場合、Claudeは実行を拒否します。
- [具体的なテストコマンド or 確認方法]
- [完了の判定基準（どうなれば成功か）]

## 5. Fallback Protocol
- 同一エラーが3回連続した場合は即時停止し人間に報告すること
- 指示の意図が不明な場合は即時停止し人間に報告すること
- 作業中断時はgit diffを出力してからロールバックすること
`;

  const step2Prompt = `
【ユーザーの要求】
${userPrompt}

【Step1の分析結果（対象ファイルと依存関係）】
${step1Result}
`;

  let step2Result = '';
  let step2Usage = {};
  try {
    // Step2ではソース全体ではなくStep1結果のみ食わせる（トークン節約）
    const res2 = await callGemini(apiKey, step2SystemInstruction, [{ text: step2Prompt }]);
    step2Result = res2.text;
    step2Usage = res2.usage;
    // Claudeが受け取るplanの推定トークン数
    const planTokens = Math.round(step2Result.length / 4);
    writeLog({ step: 2, status: 'success', result: step2Result, geminiUsage: step2Usage });
    process.stderr.write('[Step 2/2] 完了。\n');

    // トークン使用量サマリー
    const step1Prompt_tokens = step1Usage.promptTokenCount ?? '?';
    const step1Output_tokens = step1Usage.candidatesTokenCount ?? '?';
    const step2Prompt_tokens = step2Usage.promptTokenCount ?? '?';
    const step2Output_tokens = step2Usage.candidatesTokenCount ?? '?';
    const geminiTotal = (step1Usage.totalTokenCount ?? 0) + (step2Usage.totalTokenCount ?? 0);
    process.stderr.write(`
┌─────────────────────────────────────────────┐
│              Token Usage Summary            │
├─────────────────────────────────────────────┤
│ [Gemini] Step1 送信: ${String(step1Prompt_tokens).padStart(8)} tokens (推定)  │
│ [Gemini] Step1 受信: ${String(step1Output_tokens).padStart(8)} tokens          │
│ [Gemini] Step2 送信: ${String(step2Prompt_tokens).padStart(8)} tokens          │
│ [Gemini] Step2 受信: ${String(step2Output_tokens).padStart(8)} tokens          │
├─────────────────────────────────────────────┤
│ [比較] コードベース全体 (推定): ${String(baselineTokens).padStart(8)} tokens  │
│ [比較] Claudeに渡るplan (推定): ${String(planTokens).padStart(8)} tokens  │
│ → Claudeの読み込みを約 ${String(baselineTokens > 0 ? Math.round(baselineTokens / Math.max(planTokens, 1)) : '?').padStart(3)}x 削減 (推定)   │
└─────────────────────────────────────────────┘
`);
  } catch (err) {
    writeLog({ step: 2, status: 'error', error: err.message || err });
    if (err.fallback) {
      console.log(FALLBACK_MESSAGE);
      process.exit(0);
    }
    console.error(`[Error] Step2 失敗: ${err.body || err.message || JSON.stringify(err)}`);
    process.exit(1);
  }

  // 最終出力（Claude Codeが読み取る手術計画書）
  console.log(step2Result);
}

main();

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { execSync } from 'child_process';

const CONFIG_PATH = path.join(os.homedir(), '.ask-geminirc.json');
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.ttf', '.woff', '.woff2', '.eot', '.apk', '.jar', '.pdf', '.zip', '.mp3', '.mp4', '.mov']);
const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

function showHelp() {
  console.log(`
【 ask-gemini.mjs (AIオーケストレーション・プロキシツール) 】
Gemini 1.5 Pro の大容量コンテキストと言語/視覚のマルチモーダル能力を活用します。

使用方法:
  node ask-gemini.mjs "[プロンプト]" [オプション]

オプション:
  --help, -h          このヘルプを表示して終了します。
  --reset-key         保存されている API キーを削除・再設定します。
  --attach <パス>     画像やPDFなどの添付ファイルを指定します（複数指定可）。
                      指定されたファイルはBase64化され、Geminiの視覚機能で解析されます。

実例:
  node ask-gemini.mjs "カレンダーコンポーネントの表示崩れを治して" --attach "C:/path/to/error.png"
`);
  process.exit(0);
}

async function askForApiKey() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question('[初回セットアップ] Gemini API キーを入力してください: ', (key) => {
      rl.close();
      resolve(key.trim());
    });
  });
}

async function resetApiKey() {
  console.log('--- APIキーの再設定 ---');
  const newKey = await askForApiKey();
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

  const newKey = await askForApiKey();
  if (!newKey) {
    console.error('APIキーが入力されませんでした。処理を中止します。');
    process.exit(1);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ GEMINI_API_KEY: newKey }, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
  return newKey;
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
      i++; // パス部分をスキップ
    } else {
      userPromptArgs.push(args[i]);
    }
  }
  
  // オプションフラグ（--xxx や /xxx）をuserPromptから除外する
  const userPrompt = userPromptArgs.filter(a => !a.startsWith('--') && !a.startsWith('/')).join(' ');
  const apiKey = await getApiKey();

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
      process.stderr.write(`[SKIP] ${file}: ${e.message}\n`);
    }
  }

  // 3. プロンプトの組み立て
  const systemInstruction = `
あなたは世界最高峰のソフトウェアエンジニア（Gemini 1.5 Pro）です。
以下に、このプロジェクトのGit管理下にある全テキストソースコードを提供します。
これら全体を俯瞰し、ユーザーの要求に対して「どのファイルを、どのように修正すべきか」という具体的な手術計画書（Surgery Plan）を作成してください。
`;

  const finalPrompt = `
【ユーザーの要求】
${userPrompt}

【プロジェクトの全ソースコード】
${codebaseContext}
`;

  // マルチモーダル・パーツの構築（テキスト本文）
  let parts = [{ text: finalPrompt }];

  // 添付ファイルの処理（画像などのバイナリをBase64化して追加）
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
        const data = fs.readFileSync(attachmentPath).toString("base64");
        parts.push({
          inlineData: {
            mimeType: mimeType,
            data: data
          }
        });
      } else {
        process.stderr.write(`[WARNING] 指定された添付ファイルが見つかりません: ${attachmentPath}\n`);
      }
    } catch (e) {
      process.stderr.write(`[WARNING] 添付ファイルの読み込みに失敗しました (${attachmentPath}): ${e.message}\n`);
    }
  }

  const requestBody = {
    contents: [{ parts: parts }],
    systemInstruction: { parts: [{ text: systemInstruction }] }
  };

  // 4. Gemini API への送信
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        console.log(`[WARNING] Gemini API Limit Reached (${response.status} ${response.statusText}). 分析マップの作成に失敗しました。
以下の制約と順序に従って対処してください：
1. 指定のタスクを単独で解決可能か、あなた自身（Claude Code）が持つ独自ツール（ローカルファイルの個別探索と読み込み）を用いて試みてください。
2. その際、トークン上限超過や暴走を防ぐため、「巨大ソース（全ファイル）の無差別・一括読み込み」は絶対に実行しないでください。
3. もしエラーが連続した場合や、自律解決が困難・複雑すぎると判断した場合は、推測で強行せず直ちに作業を中断し、人間のユーザーに状況を報告（フォールバック）して判断を仰いでください。`);
        process.exit(0);
      } else {
        const errText = await response.text();
        console.error(`[Error] Gemini API リクエストが失敗しました。 Status: ${response.status} \n ${errText}`);
        process.exit(1);
      }
    }

    const data = await response.json();
    if (data.candidates && data.candidates.length > 0) {
      console.log(data.candidates[0].content.parts[0].text);
    } else {
      console.log('[ERROR] まさかの空レスポンスでした。内容を確認してください。');
      console.log(JSON.stringify(data, null, 2));
    }

  } catch (error) {
    console.log(`[WARNING] Gemini API Limit Reached (Network Error: ${error.message}). 分析マップの作成に失敗しました。\n以下の制約と順序に従って対処してください：\n1. 指定のタスクを単独で解決可能か、あなた自身（Claude Code）のツール（個別探索と読み込み）を用いて試みてください。\n2. その際、トークン上限超過や暴走を防ぐため、「巨大ソース（全ファイル）の無差別・一括読み込み」は絶対に実行しないでください。\n3. もしエラーが連続した場合や、自律解決が困難・複雑すぎると判断した場合は、推測で強行せず直ちに作業を中断し、人間のユーザーに状況を報告（フォールバック）して判断を仰いでください。`);
    process.exit(0);
  }
}

main();

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { execSync } from 'child_process';

const CONFIG_PATH = path.join(os.homedir(), '.ask-geminirc.json');
// バイナリファイルや、Geminiに読ませる必要のない巨大なロックファイルを除外リスト化
// SVGはテキストフォーマットのためGeminiに読ませる
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.ttf', '.woff', '.woff2', '.eot', '.apk', '.jar', '.pdf', '.zip', '.mp3', '.mp4', '.mov']);
const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

function showHelp() {
  console.log(`
【 ask-gemini.mjs (AIオーケストレーション・プロキシツール) 】
Gemini 1.5 Pro の大容量コンテキストを活用し、プロジェクト全体のコードを分析して
Claude 向けの「手術計画書（Surgery Plan）」を出力します。

使用方法:
  node ask-gemini.mjs "[プロンプト]"

引数・オプション:
  --help, -h, /help   このヘルプメッセージを表示して終了します。
  --reset-key         保存されている API キーを削除・再設定します。

実例:
  node ask-gemini.mjs "カレンダーコンポーネントの表示崩れを治すための手術計画書を作成して"
  node ask-gemini.mjs --reset-key
`);
  process.exit(0);
}

// 初回APIキー入力のプロンプト
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

// APIキーの強制リセット処理
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

// APIキーの取得
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

async function main() {
  const args = process.argv.slice(2);
  
  // 何も入力されていない、またはヘルプオプションが存在する場合
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args.includes('/help')) {
    showHelp();
  }

  // APIキーの再設定オプションが存在する場合
  if (args.includes('--reset-key') || args.includes('/reset-key')) {
    await resetApiKey();
  }

  const userPrompt = args.join(' ');
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

  const requestBody = {
    contents: [{ parts: [{ text: finalPrompt }] }],
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

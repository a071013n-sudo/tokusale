/**
 * 今日の特売くん - チラシ取得API (Google Apps Script)
 *
 * デプロイ方法:
 *  1. https://script.google.com/ で新規プロジェクトを作成し、このファイルの内容を貼り付ける
 *  2. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *     - 実行するユーザー: 自分
 *     - アクセスできるユーザー: 全員
 *  3. 発行されたURL(.../exec)を、PWA側の「設定」タブに貼り付ける
 *
 * 使い方:
 *  GET {WebAppURL}?action=fetchSale&url={チラシページのURL}
 *  → { ok:true, items:[{name, price, unit}, ...] }
 *
 * 重要な注意:
 *  スーパーのチラシサイトはサイトごとにHTML構造がまったく異なり、
 *  画像やPDFでチラシを配信しているサイトも多いため、
 *  「これを貼れば全店で自動的に動く」万能パーサーは存在しません。
 *
 *  このスクリプトは取得したチラシを3段階で解析します:
 *   (a) DOMAIN_PARSERS: ドメインごとに登録した専用パーサー(最優先・最速・無料)
 *   (b) Gemini API: チラシが画像/PDFならVisionで、HTMLならテキストを渡して
 *       商品名・価格をAIに構造化抽出させる(要APIキー設定、精度が高い)
 *   (c) genericParser: Gemini未設定/失敗時の簡易フォールバック(精度は粗め)
 *
 *  Geminiを使う場合は、スクリプトプロパティに GEMINI_API_KEY を設定してください
 *  (詳細は関数 getGeminiApiKey() 直前のコメント参照)。
 */

/**
 * Gemini APIキーの設定方法:
 *  1. https://aistudio.google.com/ でAPIキーを発行
 *  2. このプロジェクトの「プロジェクトの設定」→「スクリプト プロパティ」で
 *     キー: GEMINI_API_KEY / 値: 発行したAPIキー を追加
 *  未設定の場合は自動的に簡易フォールバック(genericParser)のみで動作します。
 */
var GEMINI_MODEL = "gemini-3.5-flash";

function getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
}

function doGet(e) {
  var action = e.parameter.action;
  var output;

  try {
    if (action === "fetchSale") {
      var url = e.parameter.url;
      if (!url) throw new Error("url パラメータが指定されていません");
      var items = fetchSaleItems(url);
      output = { ok: true, items: items };
    } else if (action === "findStoreUrl") {
      var name = e.parameter.name;
      var area = e.parameter.area || "";
      if (!name) throw new Error("name パラメータが指定されていません");
      var found = findStoreFlyerUrl(name, area);
      output = { ok: true, url: found };
    } else {
      output = { ok: false, error: "不明な action: " + action };
    }
  } catch (err) {
    output = { ok: false, error: String(err.message || err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(output))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 店名(+地域)からGoogle検索グラウンディングでチラシページのURLを探す
 * 画像チラシの中身までは読めないため、あくまで「URLを見つける」段階の処理。
 * 見つけたURLは fetchSaleItems() に渡して初めて中身が解析される。
 */
function findStoreFlyerUrl(name, area) {
  var apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("店舗検索にはGemini APIキーの設定が必要です");

  var query = area ? (area + " " + name) : name;
  var prompt =
    "日本のスーパーマーケット「" + query + "」の、本日または今週の特売チラシが見られる" +
    "公式サイトのチラシページ、またはトクバイ・Shufoo!等のチラシ掲載サービスのページを1つ探してください。\n" +
    "見つけたら次のJSON形式のみで回答してください(説明文・コードブロック不要):\n" +
    '{"url":"https://...","source":"サイト名"}\n' +
    "複数の店舗がヒットする場合は、店名・地域から最も一致度が高いと思われる1件を選んでください。" +
    '見つからない場合は {"url":null} とだけ回答してください。';

  var endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL + ":generateContent?key=" + apiKey;
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }]
  };

  var res = UrlFetchApp.fetch(endpoint, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 400) {
    throw new Error("Gemini検索エラー (HTTP " + res.getResponseCode() + ")");
  }

  var data = JSON.parse(res.getContentText());
  return extractUrlFromGroundedResponse(data);
}

function extractUrlFromGroundedResponse(data) {
  try {
    var cand = data.candidates[0];
    var text = cand.content.parts.map(function (p) { return p.text || ""; }).join("");
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    var parsed = JSON.parse(text);
    if (parsed && parsed.url) return parsed.url;
  } catch (e) {
    // JSONで取れなければ、検索グラウンディングのソースURLにフォールバック
  }
  try {
    var chunks = data.candidates[0].groundingMetadata.groundingChunks;
    if (chunks && chunks.length > 0 && chunks[0].web && chunks[0].web.uri) {
      return chunks[0].web.uri;
    }
  } catch (e2) {}
  return null;
}

/**
 * URLからHTMLを取得し、ドメインに応じたパーサーで特売情報を抽出する
 */
function fetchSaleItems(url) {
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    }
  });
  if (res.getResponseCode() >= 400) {
    throw new Error("ページの取得に失敗しました (HTTP " + res.getResponseCode() + ")");
  }

  var contentType = (res.getHeaders()["Content-Type"] || res.getHeaders()["content-type"] || "").toLowerCase();
  var domain = extractDomain(url);
  var items;

  if (contentType.indexOf("image/") === 0 || contentType.indexOf("application/pdf") === 0) {
    // チラシが画像/PDFで配信されているサイト向け: Geminiに直接読ませる
    items = geminiExtractFromBlob(res.getBlob(), contentType);
  } else {
    var html = res.getContentText();
    var parser = DOMAIN_PARSERS[domain];
    if (parser) {
      items = parser(html, url);
    } else {
      items = geminiExtractFromHtml(html);
    }
  }

  if (!items || items.length === 0) {
    // Gemini未設定/失敗時、またはヒットなしの場合の最終フォールバック
    var fallbackHtml = contentType.indexOf("text/html") > -1 || !contentType ? res.getContentText() : "";
    if (fallbackHtml) items = genericParser(fallbackHtml);
  }

  // 上限をかけて返す(表示崩れ防止)
  return (items || []).slice(0, 60);
}

/**
 * 画像/PDFのチラシをGemini Vision APIに渡して商品名・価格を抽出する
 */
function geminiExtractFromBlob(blob, mimeType) {
  var apiKey = getGeminiApiKey();
  if (!apiKey) return null; // 未設定ならnullを返し、呼び出し元でフォールバックさせる

  var base64 = Utilities.base64Encode(blob.getBytes());
  var prompt =
    "これは日本のスーパーマーケットの特売チラシです。掲載されている商品名と価格をすべて抽出し、" +
    "次のJSON配列だけを出力してください。説明文やマークダウンのコードブロックは不要です。\n" +
    '[{"name":"商品名","price":数値(円、税込表示があればそちらを優先),"unit":"1パック等の単位表記があれば(なければ空文字)"}]';

  return callGeminiJson([
    { text: prompt },
    { inlineData: { mimeType: mimeType.split(";")[0], data: base64 } }
  ]);
}

/**
 * HTMLチラシページのテキストをGeminiに渡して商品名・価格を抽出する
 */
function geminiExtractFromHtml(html) {
  var apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  var text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .slice(0, 30000); // 長すぎる場合は先頭のみ(トークン節約)

  var prompt =
    "以下は日本のスーパーマーケットのチラシ/特売情報ページから抽出したテキストです。" +
    "本日の特売商品と思われるものだけを選び、次のJSON配列だけを出力してください。" +
    "ナビゲーションメニューや無関係なテキストは無視してください。説明文やコードブロックは不要です。\n" +
    '[{"name":"商品名","price":数値(円),"unit":"単位表記があれば(なければ空文字)"}]\n\n' +
    "---テキスト---\n" + text;

  return callGeminiJson([{ text: prompt }]);
}

function callGeminiJson(parts) {
  var apiKey = getGeminiApiKey();
  var endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL + ":generateContent?key=" + apiKey;

  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { responseMimeType: "application/json" }
  };

  var res = UrlFetchApp.fetch(endpoint, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 400) {
    Logger.log("Gemini API error: " + res.getContentText());
    return null;
  }

  try {
    var data = JSON.parse(res.getContentText());
    var raw = data.candidates[0].content.parts[0].text;
    var parsed = JSON.parse(raw);
    return parsed.filter(function (it) {
      return it && it.name && typeof it.price === "number" && it.price > 0;
    });
  } catch (err) {
    Logger.log("Gemini response parse error: " + err);
    return null;
  }
}

function extractDomain(url) {
  var m = url.match(/^https?:\/\/([^\/]+)/i);
  return m ? m[1].replace(/^www\./, "") : "";
}

/**
 * ==== ドメイン別パーサー登録エリア ====
 * key: ドメイン名 (例: "aeon.com" や "aeon-town.com" など、実際に使うURLのホスト名)
 * value: function(html, url) -> [{name, price, unit}]
 *
 * 各サイトの構造は実際にHTMLを見て確認する必要があります。
 * 以下はテンプレート例です。site-a.example.com の商品が
 *   <div class="item"><p class="name">卵1パック</p><span class="price">198</span></div>
 * のような構造だった場合の実装イメージです。
 */
var DOMAIN_PARSERS = {
  // "site-a.example.com": function(html, url) {
  //   var items = [];
  //   var re = /<div class="item">[\s\S]*?<p class="name">([^<]+)<\/p>[\s\S]*?<span class="price">([\d,]+)<\/span>/g;
  //   var m;
  //   while ((m = re.exec(html)) !== null) {
  //     items.push({ name: m[1].trim(), price: Number(m[2].replace(/,/g, "")), unit: "" });
  //   }
  //   return items;
  // },
};

/**
 * 汎用フォールバックパーサー
 * 「商品名らしきテキスト」の近くにある「¥123」「128円」のような価格表記を
 * ざっくり拾う簡易ロジック。精度は高くないため、あくまで暫定表示用。
 * 実運用では対象サイトごとに DOMAIN_PARSERS に専用パーサーを追加することを推奨。
 */
function genericParser(html) {
  var text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n");

  var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);

  var items = [];
  var priceRe = /(?:¥|￥)?\s?(\d{2,5})\s?(?:円|¥|￥)/;

  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(priceRe);
    if (m) {
      var price = Number(m[1]);
      if (price < 10 || price > 50000) continue;
      // 価格行の直前1〜2行を商品名候補とする
      var nameCandidate = "";
      for (var j = i - 1; j >= Math.max(0, i - 2); j--) {
        if (lines[j] && !priceRe.test(lines[j]) && lines[j].length <= 30) {
          nameCandidate = lines[j];
          break;
        }
      }
      if (nameCandidate) {
        items.push({ name: nameCandidate, price: price, unit: "" });
      }
    }
  }

  // 重複除去
  var seen = {};
  return items.filter(function (it) {
    var k = it.name + "_" + it.price;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

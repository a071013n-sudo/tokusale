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
 *  JavaScriptで動的に描画されるサイトも多いため、
 *  「これを貼れば全店で自動的に動く」万能パーサーは存在しません。
 *
 *  このスクリプトは、
 *   (a) ドメインごとに個別パーサーを登録できる仕組み(DOMAIN_PARSERS)
 *   (b) 何も登録がない場合の汎用フォールバック(genericParser)
 *  で構成されています。実際に使うスーパーごとに、
 *  ブラウザの「ページのソースを表示」でHTML構造を確認し、
 *  DOMAIN_PARSERSに専用パーサーを追加してください。
 */

function doGet(e) {
  var action = e.parameter.action;
  var output;

  try {
    if (action === "fetchSale") {
      var url = e.parameter.url;
      if (!url) throw new Error("url パラメータが指定されていません");
      var items = fetchSaleItems(url);
      output = { ok: true, items: items };
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
  var html = res.getContentText();
  var domain = extractDomain(url);

  var parser = DOMAIN_PARSERS[domain];
  var items = parser ? parser(html, url) : genericParser(html);

  // 上限をかけて返す(表示崩れ防止)
  return items.slice(0, 60);
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

/*
  MobilyTech BR - Pos-venda por Google Apps Script

  Como usar:
  1. Crie uma planilha no Google Sheets.
  2. Abra Extensoes > Apps Script e cole este arquivo.
  3. Preencha SPREADSHEET_ID e rode setupMobilyTechPostSale().
  4. Publique como Web App e use a URL em ORDER_NOTIFICATION_ENDPOINT na Vercel.
*/

const MOBILYTECH = {
  SPREADSHEET_ID: "COLE_AQUI_O_ID_DA_PLANILHA",
  ORDERS_SHEET: "Pedidos",
  SETTINGS_SHEET: "Configuracoes",
  PRICE_REVIEW_SHEET: "Revisao de precos",
  SITE_URL: "https://mobilytechbr.vercel.app",
  SETTINGS_URL: "https://mobilytechbr.vercel.app/data/automation-settings.json",
  LOGO_URL: "https://mobilytechbr.vercel.app/assets/mobilytech-logo.png",
  SELLER_EMAIL: "mobilytechbr@gmail.com",
  WHATSAPP_URL: "https://wa.me/5511954801967?text=Ola%2C%20tenho%20uma%20duvida%20sobre%20meu%20pedido%20MobilyTech%20BR."
};

const ORDER_HEADERS = [
  "PedidoID",
  "Status",
  "Plataforma",
  "ClienteNome",
  "ClienteEmail",
  "ClienteTelefone",
  "Produto",
  "Opcionais",
  "ValorPago",
  "ModoEntrega",
  "Transportadora",
  "ServicoFrete",
  "PrecoFrete",
  "Cep",
  "Endereco",
  "LinkConfirmarEtiqueta",
  "DecisaoEtiqueta",
  "CodigoRastreio",
  "LinkRastreio",
  "EmailClienteConfirmacaoEnviado",
  "EmailVendedorVendaEnviado",
  "EmailClienteDespachoEnviado",
  "EmailClienteEntregaEnviado",
  "ReembolsoManual",
  "AtualizadoEm"
];

const PRICE_HEADERS = [
  "ProdutoID",
  "TituloSite",
  "PrecoSite",
  "LinkFacebook",
  "LinkOLX",
  "PrecoEncontrado",
  "Fonte",
  "Confianca",
  "AcaoSugerida",
  "AprovadoParaAplicar",
  "Observacao",
  "AtualizadoEm"
];

function setupMobilyTechPostSale() {
  const ss = spreadsheet_();
  ensureSheet_(ss, MOBILYTECH.ORDERS_SHEET, ORDER_HEADERS);
  const settings = ensureSheet_(ss, MOBILYTECH.SETTINGS_SHEET, ["Chave", "Valor", "Observacao"]);
  seedSettings_(settings);
  ensureSheet_(ss, MOBILYTECH.PRICE_REVIEW_SHEET, PRICE_HEADERS);
  installTrigger_("processMobilyTechAutomations", 5);
}

function processMobilyTechAutomations() {
  const settings = mergedSettings_();
  if (settingBool_(settings.postSaleEmailsEnabled, true)) {
    processPostSaleQueue_(settings);
  }
  if (settingBool_(settings.marketplacePriceSyncEnabled, false)) {
    runMarketplacePriceReview_(settings);
  }
}

function doPost(e) {
  const payload = parseIncomingPayload_(e);
  const row = upsertOrder_(payload);
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, row }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = String(e.parameter.action || "");
  if (action === "deny-label") return denyLabel_(e.parameter.order, e.parameter.token);
  return HtmlService.createHtmlOutput("MobilyTech BR automacoes ativas.");
}

function processPostSaleQueue_(settings) {
  const sheet = ordersSheet_();
  const rows = readRows_(sheet);
  rows.forEach(({ row, values }) => {
    const status = String(values.Status || "").toUpperCase();
    if (status === "PAGO") {
      if (!values.EmailClienteConfirmacaoEnviado && values.ClienteEmail) {
        sendCustomerConfirmation_(values);
        sheet.getRange(row, col_("EmailClienteConfirmacaoEnviado")).setValue(new Date());
      }
      if (settingBool_(settings.sellerNotificationsEnabled, true) && !values.EmailVendedorVendaEnviado) {
        sendSellerSaleAlert_(values, settings);
        sheet.getRange(row, col_("EmailVendedorVendaEnviado")).setValue(new Date());
      }
    }

    if (status === "DESPACHADO" && values.CodigoRastreio && !values.EmailClienteDespachoEnviado && values.ClienteEmail) {
      sendCustomerTracking_(values);
      sheet.getRange(row, col_("EmailClienteDespachoEnviado")).setValue(new Date());
    }

    if (status === "ENTREGUE" && !values.EmailClienteEntregaEnviado && values.ClienteEmail) {
      sendCustomerDelivered_(values);
      sheet.getRange(row, col_("EmailClienteEntregaEnviado")).setValue(new Date());
    }
  });
}

function sendCustomerConfirmation_(order) {
  const subject = "Compra confirmada - MobilyTech BR";
  const html = emailShell_({
    preheader: "Recebemos seu pedido e vamos preparar tudo com cuidado.",
    title: "Compra confirmada!",
    intro: `Ola, ${escapeHtml_(order.ClienteNome || "tudo bem")}! A MobilyTech BR agradece sua compra. Vamos preparar seu pedido com cuidado para ele chegar pronto para uso.`,
    blocks: [
      detailBlock_("Resumo do pedido", [
        ["Produto", order.Produto],
        ["Opcionais", order.Opcionais || "Nenhum"],
        ["Valor pago", formatMoneyText_(order.ValorPago)],
        ["Entrega", deliverySummary_(order)]
      ]),
      textBlock_("Proximos passos", "Agora o PC entra em preparacao final: revisao, limpeza, testes e embalagem. Se voce escolheu frete, voce recebera outro e-mail com o codigo de rastreamento assim que o envio for despachado.")
    ],
    ctaLabel: "Falar com a MobilyTech BR",
    ctaUrl: MOBILYTECH.WHATSAPP_URL
  });
  GmailApp.sendEmail(order.ClienteEmail, subject, "Sua compra foi confirmada pela MobilyTech BR.", { htmlBody: html, name: "MobilyTech BR" });
}

function sendSellerSaleAlert_(order, settings) {
  const sellerEmail = settings.sellerEmail || MOBILYTECH.SELLER_EMAIL;
  const subject = "Parabens, voce vendeu no site - MobilyTechBR";
  const denyUrl = buildActionUrl_("deny-label", order.PedidoID);
  const labelUrl = order.LinkConfirmarEtiqueta || "";
  const actionHtml = order.ModoEntrega === "shipping"
    ? `<p style="margin:18px 0 0"><a href="${labelUrl}" style="${buttonStyle_()}">Confirmar etiqueta</a><a href="${denyUrl}" style="${buttonStyle_("secondary")}">Negar etiqueta</a></p>`
    : "<p style='margin:18px 0 0;color:#bcd4df;font-weight:700'>Retirada local selecionada. Combine o horario com o cliente.</p>";

  const html = emailShell_({
    preheader: "Nova venda confirmada no site.",
    title: "Parabens, voce vendeu no site!",
    intro: "Venda confirmada. Confira os dados abaixo antes de preparar o pedido.",
    blocks: [
      detailBlock_("Pedido", [
        ["Produto", order.Produto],
        ["Opcionais", order.Opcionais || "Nenhum"],
        ["Valor pago", formatMoneyText_(order.ValorPago)],
        ["Plataforma", order.Plataforma]
      ]),
      detailBlock_("Cliente e entrega", [
        ["Cliente", order.ClienteNome],
        ["Email", order.ClienteEmail],
        ["Telefone", order.ClienteTelefone],
        ["Entrega", deliverySummary_(order)],
        ["Endereco", order.Endereco]
      ]),
      actionHtml
    ]
  });
  GmailApp.sendEmail(sellerEmail, subject, "Nova venda confirmada no site MobilyTechBR.", { htmlBody: html, name: "MobilyTech BR" });
}

function sendCustomerTracking_(order) {
  const trackUrl = order.LinkRastreio || `https://www2.correios.com.br/sistemas/rastreamento/default.cfm?objetos=${encodeURIComponent(order.CodigoRastreio)}`;
  const html = emailShell_({
    preheader: "Seu pedido foi despachado.",
    title: "Seu PC ja foi despachado!",
    intro: "Seu pedido saiu para envio. Agora voce pode acompanhar o trajeto pelo codigo de rastreamento.",
    blocks: [
      detailBlock_("Rastreamento", [
        ["Codigo", order.CodigoRastreio],
        ["Transportadora", order.Transportadora || "Correios"],
        ["Produto", order.Produto]
      ])
    ],
    ctaLabel: "Acompanhar pedido",
    ctaUrl: trackUrl
  });
  GmailApp.sendEmail(order.ClienteEmail, "Pedido despachado - MobilyTech BR", "Seu pedido foi despachado.", { htmlBody: html, name: "MobilyTech BR" });
}

function sendCustomerDelivered_(order) {
  const html = emailShell_({
    preheader: "Pedido entregue. Conte com a gente no pos-venda.",
    title: "Seu pedido chegou!",
    intro: "Tomara que voce curta bastante o PC. Se precisar de ajuda com instalacao, configuracao basica ou qualquer duvida inicial, chama a MobilyTech BR.",
    blocks: [
      textBlock_("Obrigado pela confianca", "Depois de testar tudo, se puder deixar uma avaliacao, isso ajuda muito outras pessoas a comprarem com seguranca tambem.")
    ],
    ctaLabel: "Falar no WhatsApp",
    ctaUrl: MOBILYTECH.WHATSAPP_URL
  });
  GmailApp.sendEmail(order.ClienteEmail, "Pedido entregue - MobilyTech BR", "Seu pedido foi entregue.", { htmlBody: html, name: "MobilyTech BR" });
}

function runMarketplacePriceReview_(settings) {
  const mode = String(settings.marketplacePriceSyncMode || "review");
  const sheet = spreadsheet_().getSheetByName(MOBILYTECH.PRICE_REVIEW_SHEET);
  const products = fetchSiteProducts_();
  if (!products.length) return;

  const existing = readRows_(sheet);
  const byId = Object.fromEntries(existing.map(({ row, values }) => [values.ProdutoID, row]));
  products.forEach((product) => {
    const candidate = findMarketplacePriceCandidate_(product);
    const values = [
      product.id,
      product.title,
      product.price,
      product.links?.facebook || "",
      product.links?.olx || "",
      candidate.price || "",
      candidate.source || "",
      candidate.confidence,
      candidate.action || (mode === "auto" ? "Aguardando alta confianca" : "Revisar manualmente"),
      false,
      candidate.note || "Facebook Marketplace e OLX podem exigir login e mudar a pagina. Para evitar trocar o preco do PC errado, este fluxo comeca como revisao.",
      new Date()
    ];
    const row = byId[product.id];
    if (row) {
      sheet.getRange(row, 1, 1, PRICE_HEADERS.length).setValues([values]);
    } else {
      sheet.appendRow(values);
    }
  });
}

function findMarketplacePriceCandidate_(product) {
  const sources = [
    ["Facebook", product.links?.facebook || ""],
    ["OLX", product.links?.olx || ""]
  ].filter(([, url]) => url);

  for (const [source, url] of sources) {
    const page = fetchPublicPage_(url);
    if (!page.ok) {
      continue;
    }
    const confidence = marketplaceMatchConfidence_(product, page.text);
    const price = extractPrice_(page.text);
    if (price && confidence >= 75) {
      return {
        price,
        source,
        confidence: `${confidence}%`,
        action: "Preco candidato encontrado; conferir antes de aplicar",
        note: "A pagina publica parece corresponder ao PC pelo titulo/configuracoes. Ainda recomendo conferir antes de aplicar automaticamente."
      };
    }
    if (price) {
      return {
        price,
        source,
        confidence: `${confidence}%`,
        action: "Revisar manualmente",
        note: "Preco encontrado, mas a confianca ficou baixa. Pode ser outro anuncio parecido ou pagina incompleta."
      };
    }
  }

  return {
    price: "",
    source: "",
    confidence: "manual",
    action: "Revisar manualmente",
    note: "Nao encontrei preco publico confiavel. Facebook/OLX podem exigir login ou bloquear leitura automatica."
  };
}

function fetchPublicPage_(url) {
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        "User-Agent": "Mozilla/5.0 MobilyTechBR price review"
      }
    });
    if (response.getResponseCode() >= 300) return { ok: false, text: "" };
    return { ok: true, text: response.getContentText().slice(0, 300000) };
  } catch (_error) {
    return { ok: false, text: "" };
  }
}

function marketplaceMatchConfidence_(product, html) {
  const text = normalizeText_(html);
  const specs = product.specs || {};
  const terms = [
    product.title,
    ...(product.tags || []),
    specs.processor,
    specs.memory,
    specs.gpu,
    specs.storage,
    specs.powerSupply
  ]
    .filter(Boolean)
    .flatMap((item) => normalizeText_(item).split(/[^a-z0-9]+/))
    .filter((term) => term.length >= 3 && !["gamer", "com", "ram", "ssd"].includes(term));
  const uniqueTerms = [...new Set(terms)].slice(0, 20);
  if (!uniqueTerms.length) return 0;
  const hits = uniqueTerms.filter((term) => text.includes(term)).length;
  return Math.round((hits / uniqueTerms.length) * 100);
}

function extractPrice_(html) {
  const matches = String(html).match(/R\$\s?[\d.]+,\d{2}|R\$\s?[\d.]+/g);
  if (!matches || !matches.length) return "";
  return matches[0].replace(/\s+/g, " ");
}

function normalizeText_(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function upsertOrder_(payload) {
  const sheet = ordersSheet_();
  const order = normalizeOrder_(payload);
  const existing = readRows_(sheet).find(({ values }) => String(values.PedidoID) === order.PedidoID);
  const rowValues = ORDER_HEADERS.map((header) => order[header] || "");
  if (existing) {
    sheet.getRange(existing.row, 1, 1, ORDER_HEADERS.length).setValues([rowValues]);
    return existing.row;
  }
  sheet.appendRow(rowValues);
  return sheet.getLastRow();
}

function normalizeOrder_(payload) {
  const shippingCustomer = parseJson_(payload.shipping_customer, {});
  const customer = {
    name: payload.customer_name || shippingCustomer.name || "",
    email: payload.customer_email || payload.email || shippingCustomer.email || "",
    phone: payload.customer_phone || shippingCustomer.phone || ""
  };
  return {
    PedidoID: String(payload.payment_id || payload.pagamento || `pedido-${Date.now()}`),
    Status: String(payload.order_status || "PAGO").toUpperCase(),
    Plataforma: payload.platform || "Site",
    ClienteNome: customer.name,
    ClienteEmail: customer.email,
    ClienteTelefone: customer.phone,
    Produto: payload.product_title || payload.produto || "",
    Opcionais: payload.selected_addons || "Nenhum",
    ValorPago: payload.amount_paid || "",
    ModoEntrega: payload.delivery_mode || (payload.shipping_requested === "true" ? "shipping" : "pickup"),
    Transportadora: payload.shipping_carrier || "",
    ServicoFrete: payload.shipping_service_name || "",
    PrecoFrete: payload.shipping_price || "",
    Cep: payload.shipping_postal_code || shippingCustomer.postalCode || "",
    Endereco: [shippingCustomer.street, shippingCustomer.number, shippingCustomer.complement, shippingCustomer.district, shippingCustomer.city, shippingCustomer.state].filter(Boolean).join(", "),
    LinkConfirmarEtiqueta: payload.label_confirmation_url || payload.confirmar_etiqueta || "",
    DecisaoEtiqueta: "",
    CodigoRastreio: "",
    LinkRastreio: "",
    EmailClienteConfirmacaoEnviado: "",
    EmailVendedorVendaEnviado: "",
    EmailClienteDespachoEnviado: "",
    EmailClienteEntregaEnviado: "",
    ReembolsoManual: "",
    AtualizadoEm: new Date()
  };
}

function denyLabel_(orderId, token) {
  if (!verifyActionToken_(orderId, token)) {
    return HtmlService.createHtmlOutput("Link invalido ou expirado.");
  }
  const sheet = ordersSheet_();
  const found = readRows_(sheet).find(({ values }) => String(values.PedidoID) === String(orderId));
  if (!found) return HtmlService.createHtmlOutput("Pedido nao encontrado.");
  sheet.getRange(found.row, col_("DecisaoEtiqueta")).setValue("Negada");
  sheet.getRange(found.row, col_("Status")).setValue("CANCELAR");
  sheet.getRange(found.row, col_("ReembolsoManual")).setValue("Pendente");
  return HtmlService.createHtmlOutput("Etiqueta negada. O pedido foi marcado para cancelamento/reembolso manual.");
}

function emailShell_({ preheader, title, intro, blocks = [], ctaLabel, ctaUrl }) {
  const blocksHtml = blocks.join("");
  const cta = ctaLabel && ctaUrl
    ? `<p style="text-align:center;margin:26px 0 6px"><a href="${ctaUrl}" style="${buttonStyle_()}">${escapeHtml_(ctaLabel)}</a></p>`
    : "";
  return `
  <div style="display:none;max-height:0;overflow:hidden">${escapeHtml_(preheader || "")}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#02070d;margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:#f5fbff">
    <tr><td align="center" style="padding:28px 14px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;border:1px solid rgba(34,240,196,.22);border-radius:18px;background:linear-gradient(180deg,#071b2d,#03101b);overflow:hidden">
        <tr><td align="center" style="padding:30px 26px 18px;background:radial-gradient(circle at 50% 0,rgba(4,183,255,.20),transparent 260px)">
          <img src="${MOBILYTECH.LOGO_URL}" width="96" alt="MobilyTech BR" style="display:block;border-radius:999px;margin:0 auto 16px">
          <div style="color:#22f0c4;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase">MobilyTech BR</div>
          <h1 style="margin:10px 0 0;color:#ffffff;font-size:32px;line-height:1.08">${escapeHtml_(title)}</h1>
          <p style="margin:14px auto 0;max-width:540px;color:#c6d8e4;font-size:16px;line-height:1.55;font-weight:700">${escapeHtml_(intro)}</p>
        </td></tr>
        <tr><td style="padding:10px 26px 28px">${blocksHtml}${cta}</td></tr>
        <tr><td style="padding:18px 26px;border-top:1px solid rgba(88,214,255,.18);color:#8fa6b8;font-size:12px;line-height:1.5;text-align:center">
          MobilyTech BR - PCs e Hardware<br>
          Envio para todo o Brasil | Site oficial | OLX | Facebook Marketplace | Mercado Livre
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

function detailBlock_(title, rows) {
  const rowsHtml = rows
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([label, value]) => `<tr><td style="padding:7px 0;color:#8fb2c4;font-size:12px;font-weight:800;text-transform:uppercase">${escapeHtml_(label)}</td><td style="padding:7px 0;color:#f5fbff;font-size:14px;font-weight:800;text-align:right">${escapeHtml_(value)}</td></tr>`)
    .join("");
  return `<div style="${cardStyle_()}"><h2 style="${blockTitleStyle_()}">${escapeHtml_(title)}</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rowsHtml}</table></div>`;
}

function textBlock_(title, text) {
  return `<div style="${cardStyle_()}"><h2 style="${blockTitleStyle_()}">${escapeHtml_(title)}</h2><p style="margin:0;color:#c6d8e4;font-size:14px;line-height:1.6;font-weight:700">${escapeHtml_(text)}</p></div>`;
}

function buttonStyle_(variant) {
  if (variant === "secondary") {
    return "display:inline-block;margin:6px 6px;padding:13px 18px;border:1px solid rgba(88,214,255,.34);border-radius:10px;color:#dff7ff;background:#0b2134;text-decoration:none;font-weight:900";
  }
  return "display:inline-block;margin:6px 6px;padding:13px 18px;border-radius:10px;color:#021018;background:linear-gradient(135deg,#7df8e0,#22f0c4 52%,#04b7ff);text-decoration:none;font-weight:900";
}

function cardStyle_() {
  return "margin:14px 0 0;padding:18px;border:1px solid rgba(88,214,255,.22);border-radius:14px;background:rgba(255,255,255,.045)";
}

function blockTitleStyle_() {
  return "margin:0 0 12px;color:#22f0c4;font-size:13px;letter-spacing:.08em;text-transform:uppercase";
}

function deliverySummary_(order) {
  if (order.ModoEntrega === "pickup") return "Retirada local - Vila Suzana, Sao Paulo, SP";
  return [order.Transportadora, order.ServicoFrete, order.Cep ? `CEP ${order.Cep}` : ""].filter(Boolean).join(" - ");
}

function parseIncomingPayload_(e) {
  if (e.postData && e.postData.contents) {
    const type = String(e.postData.type || "");
    if (type.includes("application/json")) return JSON.parse(e.postData.contents);
  }
  return e.parameter || {};
}

function spreadsheet_() {
  return SpreadsheetApp.openById(MOBILYTECH.SPREADSHEET_ID);
}

function ordersSheet_() {
  return spreadsheet_().getSheetByName(MOBILYTECH.ORDERS_SHEET);
}

function ensureSheet_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (current.join("") !== headers.join("")) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function seedSettings_(sheet) {
  const rows = [
    ["postSaleEmailsEnabled", "true", "Envia e-mails para cliente e vendedor."],
    ["sellerNotificationsEnabled", "true", "Envia aviso interno de venda confirmada."],
    ["sellerEmail", MOBILYTECH.SELLER_EMAIL, "Destino do e-mail interno."],
    ["marketplacePriceSyncEnabled", "false", "Comece desligado."],
    ["marketplacePriceSyncMode", "review", "review ou auto."],
    ["marketplacePriceSyncIntervalMinutes", "360", "Recomendado: 6 horas."]
  ];
  if (sheet.getLastRow() <= 1) sheet.getRange(2, 1, rows.length, 3).setValues(rows);
}

function installTrigger_(handler, minutes) {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === handler)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(minutes).create();
}

function mergedSettings_() {
  return { ...sheetSettings_(), ...siteSettings_() };
}

function sheetSettings_() {
  const sheet = spreadsheet_().getSheetByName(MOBILYTECH.SETTINGS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return {};
  return Object.fromEntries(sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().filter((row) => row[0]).map((row) => [row[0], row[1]]));
}

function siteSettings_() {
  try {
    const response = UrlFetchApp.fetch(`${MOBILYTECH.SETTINGS_URL}?t=${Date.now()}`, { muteHttpExceptions: true });
    if (response.getResponseCode() >= 300) return {};
    return JSON.parse(response.getContentText());
  } catch (_error) {
    return {};
  }
}

function readRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().map((rowValues, index) => ({
    row: index + 2,
    values: Object.fromEntries(headers.map((header, i) => [header, rowValues[i]]))
  }));
}

function col_(header) {
  return ORDER_HEADERS.indexOf(header) + 1;
}

function fetchSiteProducts_() {
  try {
    const response = UrlFetchApp.fetch(`${MOBILYTECH.SITE_URL}/data/products.json?t=${Date.now()}`, { muteHttpExceptions: true });
    if (response.getResponseCode() >= 300) return [];
    return JSON.parse(response.getContentText()).filter((product) => product.active !== false);
  } catch (_error) {
    return [];
  }
}

function buildActionUrl_(action, orderId) {
  const baseUrl = ScriptApp.getService().getUrl();
  if (!baseUrl) return "";
  const token = actionToken_(orderId);
  return `${baseUrl}?action=${encodeURIComponent(action)}&order=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`;
}

function actionToken_(orderId) {
  const secret = Session.getEffectiveUser().getEmail() || MOBILYTECH.SELLER_EMAIL;
  const raw = `${orderId}|${Utilities.formatDate(new Date(), "GMT", "yyyyMMdd")}`;
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(raw, secret));
}

function verifyActionToken_(orderId, token) {
  return token && token === actionToken_(orderId);
}

function settingBool_(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function formatMoneyText_(value) {
  const number = Number(String(value || "").replace(/[^\d,.-]/g, "").replace(",", "."));
  if (!Number.isFinite(number)) return String(value || "");
  return `R$ ${number.toFixed(2).replace(".", ",")}`;
}

function parseJson_(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function escapeHtml_(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendTestConfirmationEmail() {
  sendCustomerConfirmation_({
    ClienteNome: "Julian",
    ClienteEmail: MOBILYTECH.SELLER_EMAIL,
    Produto: "PC Gamer MobilyTech BR",
    Opcionais: "SSD 240GB",
    ValorPago: "950",
    ModoEntrega: "shipping",
    Transportadora: "Correios",
    ServicoFrete: "SEDEX",
    Cep: "05641-090"
  });
}

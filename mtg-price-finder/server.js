// Local-only bridge for live Archidekt stock and its Card Kingdom price field.
// Uses Node's built-in modules only; no paid hosting or third-party packages.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');

// Keep local use private to this computer; Render supplies PORT for online hosting.
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const COLLECTION_ID = 366983;
const ARCHIDEKT_URL = `https://archidekt.com/collection/v2/${COLLECTION_ID}`;
const ARCHIDEKT_EXPORT = `https://archidekt.com/api/collection/export/v2/${COLLECTION_ID}/`;
const CARDKINGDOM_URL = 'https://api.cardkingdom.com/api/v2/pricelist';
const YANNICK_API = 'https://yannickthegathering.com/api/products';
const POWER9_SEARCH = 'https://power9cardstore.com/search/suggest.json';
const SABAI_SEARCH = 'https://sabaicards.com/products/singles';
const HOBBY_BUGONG_API = 'https://api.hobbybugong.com/api/store/v1/mtg/singles';
const CACHE_MS = 60 * 1000;
const CK_CACHE_MS = 6 * 60 * 60 * 1000;
const FIELDS = [
  'quantity',
  'card__oracleCard__name',
  'modifier',
  'card__edition__editionname',
  'card__edition__editioncode',
  'card__collectorNumber',
  'card__uid',
  'card__prices__ck',
];

let catalogCache = null;
let catalogLoadedAt = 0;
let catalogPromise = null;
let ckPriceCache = null;
let ckPricesLoadedAt = 0;
let ckPricesPromise = null;

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function absoluteImageUrl(value, base = 'https://power9cardstore.com') {
  const raw = typeof value === 'string' ? value : (value?.src || value?.url || '');
  if (!raw) return '';
  try {
    const url = new URL(raw, base);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}

function isPublicIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

async function requestPublicJson(targetUrl) {
  const target = new URL(targetUrl);
  const host = target.hostname.toLowerCase().replace(/\.$/, '');
  if (target.protocol !== 'https:' || (target.port && target.port !== '443') || !host.includes('.') || net.isIP(host) || /(^|\.)(localhost|local|internal)$/.test(host)) {
    throw new Error('Only public HTTPS shop websites can be checked automatically.');
  }
  const resolved = await dns.lookup(host, { all: true, family: 4, verbatim: true });
  const address = resolved.find(record => isPublicIpv4(record.address))?.address;
  if (!address) throw new Error('The shop website did not resolve to a public address.');
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: host,
      servername: host,
      port: 443,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: { 'Accept': 'application/json', 'User-Agent': 'ManaMarket/1.0' },
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`Shop check returned HTTP ${response.statusCode}.`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(new Error('Shop response was too large to inspect.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('The shop response was not JSON.')); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('Shop check timed out.')));
    request.on('error', reject);
    request.end();
  });
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|quot|apos|#39|amp|lt|gt);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key === 'quot') return '"';
    if (key === 'apos' || key === '#39') return "'";
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return match; }
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

function headerKey(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function numberOrNull(value) {
  const s = String(value ?? '').replace(/[$,]/g, '').trim();
  if (!s || /^[-—]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function csvObjects(csv, knownHeader = null) {
  const rows = parseCsv(csv);
  if (!rows.length) return { products: [], header: knownHeader };
  const possibleHeader = rows[0].map(headerKey);
  const headerLooksValid = possibleHeader.some(k => ['cardoraclecardname', 'cardname', 'name'].includes(k)) && possibleHeader.some(k => ['quantity', 'qty'].includes(k));
  const displayHeader = headerLooksValid ? rows[0] : knownHeader;
  if (!displayHeader) throw new Error('Archidekt export did not include its CSV header.');
  const header = displayHeader.map(headerKey);
  const find = (...names) => names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1;
  const cols = {
    quantity: find('quantity', 'qty'),
    name: find('cardoraclecardname', 'cardname', 'name'),
    finish: find('modifier', 'finish', 'foil'),
    setName: find('cardeditioneditionname', 'editionname', 'edition', 'setname'),
    setCode: find('cardeditioneditioncode', 'editioncode', 'setcode'),
    collector: find('cardcollectornumber', 'collectornumber', 'collectorno'),
    printingId: find('carduid', 'scryfallid', 'printingid'),
    ckPrice: find('cardpricesck', 'pricesck', 'ckprice', 'pricecardkingdom', 'cardkingdomprice', 'price1'),
  };
  if (cols.name < 0 || cols.quantity < 0) throw new Error('Archidekt export columns were not recognized.');
  const dataRows = headerLooksValid ? rows.slice(1) : rows;
  const products = dataRows.map(r => ({
    name: r[cols.name] || '',
    quantity: Math.max(0, Number.parseInt(r[cols.quantity], 10) || 0),
    finish: cols.finish >= 0 ? (r[cols.finish] || 'Normal') : 'Normal',
    setName: cols.setName >= 0 ? r[cols.setName] || '' : '',
    setCode: cols.setCode >= 0 ? r[cols.setCode] || '' : '',
    collector: cols.collector >= 0 ? r[cols.collector] || '' : '',
    printingId: cols.printingId >= 0 ? r[cols.printingId] || '' : '',
    archidektCKPrice: cols.ckPrice >= 0 ? numberOrNull(r[cols.ckPrice]) : null,
  })).filter(p => p.name);
  return { products, header: displayHeader };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Upstream request failed (${response.status}).`);
  return response.json();
}

async function loadCatalog() {
  if (catalogCache && Date.now() - catalogLoadedAt < CACHE_MS) return catalogCache;
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const records = [];
    let page = 1, more = true, totalRows = 0, csvHeader = null;
    while (more && page <= 30) {
      const payload = await requestJson(ARCHIDEKT_EXPORT, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Referer': ARCHIDEKT_URL },
        body: JSON.stringify({ fields: FIELDS, page, game: 1, pageSize: 2500 }),
      });
      if (typeof payload.content !== 'string') throw new Error('Archidekt did not return collection rows.');
      const parsed = csvObjects(payload.content, csvHeader);
      csvHeader = parsed.header;
      records.push(...parsed.products);
      totalRows = Number(payload.totalRows) || totalRows;
      more = Boolean(payload.moreContent);
      page++;
    }
    if (!records.length) throw new Error('The public Lung Ji collection returned no card rows.');
    catalogCache = records;
    catalogLoadedAt = Date.now();
    return records;
  })().finally(() => { catalogPromise = null; });
  return catalogPromise;
}

async function loadCardKingdomPrices() {
  if (ckPriceCache && Date.now() - ckPricesLoadedAt < CK_CACHE_MS) return ckPriceCache;
  if (ckPricesPromise) return ckPricesPromise;
  ckPricesPromise = (async () => {
    const payload = await requestJson(CARDKINGDOM_URL, { headers: { 'Accept': 'application/json' } });
    const products = Array.isArray(payload.data) ? payload.data : [];
    const prices = new Map();
    for (const p of products) {
      const id = String(p.scryfall_id || '').toLowerCase();
      if (!id) continue;
      const retail = Number(p.condition_values?.nm_price ?? p.price_retail);
      if (Number.isFinite(retail) && retail > 0) prices.set(id, retail);
    }
    ckPriceCache = prices;
    ckPricesLoadedAt = Date.now();
    return prices;
  })().catch(() => null).finally(() => { ckPricesPromise = null; });
  return ckPricesPromise;
}

async function searchLungJi(name) {
  const wanted = normalize(name);
  if (!wanted) return { products: [], checkedAt: new Date().toISOString(), source: 'Archidekt' };
  const records = await loadCatalog();
  const matches = records.filter(p => normalize(p.name) === wanted);
  let ckPrices = null;
  if (matches.some(p => p.archidektCKPrice == null && p.printingId)) ckPrices = await loadCardKingdomPrices();
  const products = matches.map(p => {
    // Archidekt's configured Card Kingdom source is the price shown in the
    // public collection. Prefer it so the result matches Lung Ji's catalog.
    // Use the Card Kingdom feed only when Archidekt has no price for the exact
    // printing.
    const liveCKPrice = ckPrices?.get(String(p.printingId || '').toLowerCase());
    const price = p.archidektCKPrice ?? liveCKPrice;
    const cardKingdomSearch = `https://www.cardkingdom.com/catalog/search?search=${encodeURIComponent(`${p.name} ${p.setName}`.trim())}`;
    return {
      id: `${p.printingId}|${p.setCode}|${p.collector}|${p.finish}`,
      name: p.name,
      group_name: p.setName || p.setCode || 'Lung Ji catalog',
      quantity: p.quantity,
      price,
      currency: 'USD',
      priceSource: p.archidektCKPrice != null ? 'Card Kingdom price shown in Archidekt' : (liveCKPrice != null ? 'Card Kingdom live feed · fallback' : 'Card Kingdom price unavailable'),
      url: cardKingdomSearch,
      image_url: p.printingId ? `https://api.scryfall.com/cards/${encodeURIComponent(p.printingId)}?format=image&version=small` : '',
      printingId: p.printingId,
      finish: p.finish,
    };
  });
  products.sort((a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity));
  return { products, checkedAt: new Date().toISOString(), source: ARCHIDEKT_URL, totalCatalogRows: records.length };
}

async function searchYannick(name) {
  const wanted = String(name || '').trim().toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  if (!wanted) return { products: [], checkedAt: new Date().toISOString(), source: 'Yannick' };
  const endpoint = new URL(YANNICK_API);
  endpoint.searchParams.set('search', name);
  endpoint.searchParams.set('limit', '100');
  endpoint.searchParams.set('inStock', '0');
  const payload = await requestJson(endpoint.toString(), { headers: { 'Accept': 'application/json' } });
  const products = [];
  for (const item of (Array.isArray(payload.products) ? payload.products : [])) {
    if (item.product_type !== 'MTG Single' || !item.handle || !item.title) continue;
    const title = String(item.title).trim().toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
    // Their single listings append the collector number in parentheses after
    // the card name, e.g. "Sol Ring (7) (CC2)". Require that boundary so a
    // search for one card does not include cards whose names merely start alike.
    if (title !== wanted && !title.startsWith(`${wanted} (`)) continue;
    const image = item.image?.src || item.images?.[0]?.src || '';
    const setName = item.expansionName || item.abbreviation || 'MTG single';
    const variants = (Array.isArray(item.variants) ? item.variants : []).filter(v => Number.isFinite(Number(v.price)) && Number(v.price) >= 0);
    const stocked = variants.filter(v => Number(v.inventory_quantity) > 0);
    const choices = stocked.length ? stocked : variants;
    const byName = value => choices.find(v => String(v.title || '').trim().toLocaleLowerCase() === value);
    // The shop's result cards default to Near Mint. Match that visible price
    // whenever it is available; use Near Mint foil next, then the cheapest
    // actually available condition. If the printing is entirely out of stock,
    // retain the default Near Mint price (or the cheapest listed condition).
    const variant = byName('near mint') || byName('near mint - foil') || choices.slice().sort((a, b) => Number(a.price) - Number(b.price))[0];
    if (!variant) continue;
    const price = Number(variant.price);
    const quantity = Math.max(0, Number(variant.inventory_quantity) || 0);
    products.push({
      id: String(item.id || item.handle),
      name: item.title,
      group_name: `${setName} · ${variant.title || 'Condition not listed'}`,
      quantity,
      price,
      currency: 'THB',
      priceSource: `Yannick · ${variant.title || 'price'}`,
      url: `https://yannickthegathering.com/products/${encodeURIComponent(item.handle)}${variant.id ? `?variant=${encodeURIComponent(variant.id)}` : ''}`,
      image_url: image,
    });
  }
  products.sort((a, b) => a.price - b.price);
  return { products, checkedAt: new Date().toISOString(), source: 'Yannick live catalog', matchedProducts: payload.count ?? products.length };
}

async function searchPower9(name) {
  const wanted = String(name || '').trim().toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  if (!wanted) return { products: [], checkedAt: new Date().toISOString(), source: 'Power 9' };
  const endpoint = new URL(POWER9_SEARCH);
  endpoint.searchParams.set('q', name);
  endpoint.searchParams.set('resources[type]', 'product');
  endpoint.searchParams.set('resources[limit]', '10');
  endpoint.searchParams.set('resources[options][unavailable_products]', 'last');
  const payload = await requestJson(endpoint.toString(), { headers: { 'Accept': 'application/json' } });
  const found = payload.resources?.results?.products;
  const matches = [];
  for (const item of (Array.isArray(found) ? found : [])) {
    const title = String(item.title || '').trim();
    const normalizedTitle = title.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
    if (!title || (normalizedTitle !== wanted && !normalizedTitle.startsWith(`${wanted} `))) continue;
    if (item.handle) matches.push({ suggestion: item, title });
  }
  const productResults = await Promise.allSettled(matches.map(({ suggestion }) => requestJson(`https://power9cardstore.com/products/${encodeURIComponent(suggestion.handle)}.js`, { headers: { 'Accept': 'application/json' } })));
  const products = [];
  for (let i = 0; i < productResults.length; i++) {
    const result = productResults[i];
    if (result.status !== 'fulfilled') continue;
    const item = result.value, suggestion = matches[i].suggestion;
    const variants = (Array.isArray(item.variants) ? item.variants : []).filter(v => Number.isFinite(Number(v.price)) && Number(v.price) >= 0);
    const available = variants.filter(v => v.available);
    const pool = available.length ? available : variants;
    const selected = pool.find(v => /^near mint$/i.test(String(v.title || '').trim()))
      || pool.find(v => /^near mint foil$/i.test(String(v.title || '').trim()))
      || pool.slice().sort((a, b) => Number(a.price) - Number(b.price))[0];
    if (!selected) continue;
    const price = Number(selected.price) / 100;
    const isAvailable = Boolean(selected.available);
    const image = absoluteImageUrl(suggestion.image) || absoluteImageUrl(item.featured_image) || absoluteImageUrl(item.images?.[0]);
    products.push({
      id: String(item.id || item.handle || suggestion.handle),
      name: item.title || matches[i].title,
      group_name: `Power 9 listing · ${selected.title || 'Condition not listed'}`,
      quantity: null,
      quantityKnown: false,
      available: isAvailable,
      price,
      currency: 'THB',
      priceSource: `Power 9 · ${selected.title || 'listed variant'}`,
      url: `https://power9cardstore.com/products/${encodeURIComponent(item.handle || suggestion.handle)}${selected.id ? `?variant=${encodeURIComponent(selected.id)}` : ''}`,
      image_url: image,
    });
  }
  products.sort((a, b) => a.price - b.price);
  return { products, checkedAt: new Date().toISOString(), source: 'Power 9 public Shopify search' };
}

async function detectShopConnector(shopUrl) {
  let origin;
  try {
    const input = new URL(String(shopUrl || ''));
    if (input.protocol !== 'https:') throw new Error('Use the shop’s secure https:// address to check for a live connection.');
    origin = input.origin;
  } catch (error) {
    if (error.message.startsWith('Use the shop')) throw error;
    throw new Error('Enter a valid secure https:// shop address.');
  }

  const suggestionUrl = new URL('/search/suggest.json', origin);
  suggestionUrl.searchParams.set('q', 'sol ring');
  suggestionUrl.searchParams.set('resources[type]', 'product');
  suggestionUrl.searchParams.set('resources[limit]', '1');
  suggestionUrl.searchParams.set('resources[options][unavailable_products]', 'last');
  let isShopify = false, accessBlocked = false;
  try {
    const payload = await requestPublicJson(suggestionUrl.toString());
    isShopify = Array.isArray(payload.resources?.results?.products);
  } catch (error) { accessBlocked = /HTTP 403/.test(error.message); }

  if (!isShopify) {
    const productsUrl = new URL('/products.json?limit=1', origin);
    try {
      const payload = await requestPublicJson(productsUrl.toString());
      isShopify = Array.isArray(payload.products) && payload.products.length > 0 && payload.products.every(p => p && typeof p.handle === 'string' && Array.isArray(p.variants));
    } catch (error) { accessBlocked ||= /HTTP 403/.test(error.message); }
  }
  if (!isShopify) return {
    connected: false,
    message: accessBlocked
      ? 'The shop blocked automatic catalog access (HTTP 403). Added for manual searching.'
      : 'No supported public catalog was detected. Added for manual searching.',
  };

  let currency = '';
  try {
    const cart = await requestPublicJson(new URL('/cart.js', origin).toString());
    const code = String(cart.currency || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) currency = code;
  } catch {}
  return { connected: true, platform: 'shopify', currency, message: 'Shopify catalog connected. Prices and availability will be checked live.' };
}

async function searchConnectedShopify(name, shopUrl, currencyCode = '') {
  const wanted = normalize(name);
  if (!wanted) return { products: [], checkedAt: new Date().toISOString() };
  const input = new URL(String(shopUrl || ''));
  const origin = input.origin;
  const endpoint = new URL('/search/suggest.json', origin);
  endpoint.searchParams.set('q', name);
  endpoint.searchParams.set('resources[type]', 'product');
  endpoint.searchParams.set('resources[limit]', '10');
  endpoint.searchParams.set('resources[options][unavailable_products]', 'last');
  const payload = await requestPublicJson(endpoint.toString());
  const suggestions = payload.resources?.results?.products;
  if (!Array.isArray(suggestions)) throw new Error('The shop’s public Shopify catalog response changed.');
  const matches = suggestions.filter(item => {
    const title = normalize(item.title || '');
    return item.handle && (title === wanted || title.startsWith(`${wanted} `));
  });
  const details = await Promise.allSettled(matches.map(item => requestPublicJson(new URL(`/products/${encodeURIComponent(item.handle)}.js`, origin).toString())));
  const products = [];
  for (let i = 0; i < details.length; i++) {
    const result = details[i];
    if (result.status !== 'fulfilled') continue;
    const item = result.value;
    const variants = (Array.isArray(item.variants) ? item.variants : []).filter(v => Number.isFinite(Number(v.price)) && Number(v.price) >= 0);
    const available = variants.filter(v => v.available);
    const pool = available.length ? available : variants;
    const selected = pool.find(v => /^near mint$/i.test(String(v.title || '').trim()))
      || pool.find(v => /^near mint foil$/i.test(String(v.title || '').trim()))
      || pool.slice().sort((a, b) => Number(a.price) - Number(b.price))[0];
    if (!selected) continue;
    const handle = String(item.handle || matches[i].handle);
    const image = absoluteImageUrl(item.featured_image) || absoluteImageUrl(item.images?.[0]) || absoluteImageUrl(matches[i].image, origin);
    products.push({
      id: String(item.id || handle),
      name: item.title || matches[i].title,
      group_name: `Shopify listing · ${selected.title || 'Condition not listed'}`,
      quantity: null,
      quantityKnown: false,
      available: Boolean(selected.available),
      price: Number(selected.price) / 100,
      currency: /^[A-Z]{3}$/.test(currencyCode) ? currencyCode : '',
      priceSource: `Live shop listing · ${selected.title || 'listed variant'}`,
      url: new URL(`/products/${encodeURIComponent(handle)}${selected.id ? `?variant=${encodeURIComponent(selected.id)}` : ''}`, origin).toString(),
      image_url: image,
    });
  }
  products.sort((a, b) => a.price - b.price);
  return { products, checkedAt: new Date().toISOString(), source: 'Shopify public product catalog', resultLimit: 10 };
}

async function searchSabai(name) {
  const wanted = normalize(name);
  if (!wanted) return { products: [], checkedAt: new Date().toISOString(), source: 'Sabai Card' };
  const products = [];
  let page = 1, lastPage = 1;
  // Sabai renders its public singles catalog in an Inertia HTML page. Its
  // public browser search supports the same `search`, `sort`, and `page` query
  // parameters, so read the live catalog directly without an account/API key.
  while (page <= lastPage && page <= 100) {
    const endpoint = new URL(SABAI_SEARCH);
    endpoint.searchParams.set('search', name);
    endpoint.searchParams.set('sort', 'priceAsc');
    if (page > 1) endpoint.searchParams.set('page', String(page));
    const response = await fetch(endpoint, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; ManaMarket/1.0)',
      },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`Sabai Card request failed (${response.status}).`);
    const html = await response.text();
    const match = html.match(/<div id="app"[^>]*\bdata-page="([^"]+)"/i);
    if (!match) throw new Error('Sabai Card did not return its public catalog data.');
    let pageData;
    try { pageData = JSON.parse(decodeHtmlEntities(match[1])); }
    catch { throw new Error('Sabai Card returned catalog data in an unsupported format.'); }
    const listing = pageData?.props?.datas;
    if (!listing || !Array.isArray(listing.data)) throw new Error('Sabai Card catalog results were missing.');
    lastPage = Math.max(1, Number(listing.last_page) || 1);
    for (const item of listing.data) {
      const cardName = String(item.original_name || item.name || '').trim();
      if (!cardName || normalize(cardName) !== wanted) continue;
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const id = String(item.id || '');
      products.push({
        id: `sabai-${id}`,
        name: item.name || cardName,
        group_name: [item.expansion, item.variation].filter(Boolean).join(' · ') || 'MTG single',
        quantity,
        price: item.price != null && Number.isFinite(Number(item.price)) ? Number(item.price) : null,
        currency: 'THB',
        priceSource: 'Sabai Card live listing',
        url: id ? `https://sabaicards.com/products/view/${encodeURIComponent(id)}` : SABAI_SEARCH,
        image_url: absoluteImageUrl(item.image_path, 'https://sabaicards.com'),
        printingId: String(item.scryfall_id || ''),
        finish: item.variation || '',
      });
    }
    page++;
  }
  products.sort((a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity));
  return { products, checkedAt: new Date().toISOString(), source: 'Sabai Card live singles catalog' };
}

async function searchHobbyBugong(name) {
  const wanted = normalize(name);
  if (!wanted) return { products: [], checkedAt: new Date().toISOString(), source: 'Hobby Bugong' };
  const products = [];
  for (const finish of ['NORMAL', 'FOIL']) {
    let page = 1, totalPages = 1;
    while (page <= totalPages && page <= 100) {
      const endpoint = new URL(HOBBY_BUGONG_API);
      endpoint.searchParams.set('search', name);
      endpoint.searchParams.set('page', String(page));
      endpoint.searchParams.set('pageSize', '100');
      endpoint.searchParams.set('finish', finish);
      endpoint.searchParams.set('showAll', 'true');
      endpoint.searchParams.set('sortBy', 'PRICE_ASC');
      const payload = await requestJson(endpoint.toString(), {
        headers: {
          'Accept': 'application/json',
          'Origin': 'https://www.hobbybugong.com',
          'Referer': 'https://www.hobbybugong.com/shop/mtg/singles',
        },
      });
      const result = payload?.result;
      const singles = result?.singles;
      if (!Array.isArray(singles)) throw new Error('Hobby Bugong did not return its singles catalog.');
      totalPages = Math.max(1, Number(result.pagination?.totalPages) || 1);
      for (const item of singles) {
        const cardName = String(item.name || '').trim();
        if (!cardName || normalize(cardName) !== wanted) continue;
        const options = Object.entries(item.inventories || {}).map(([condition, inventory]) => ({
          condition,
          id: String(inventory?.id || ''),
          price: Number(inventory?.price),
          stock: Math.max(0, Number(inventory?.stock) || 0),
        })).filter(option => Number.isFinite(option.price) && option.price >= 0);
        const available = options.filter(option => option.stock > 0);
        const pool = available.length ? available : options;
        pool.sort((a, b) => a.price - b.price || (a.condition === 'NM' ? -1 : b.condition === 'NM' ? 1 : 0));
        const selected = pool[0];
        const slug = String(item.slug || '');
        products.push({
          id: `bugong-${item.id || slug}-${item.finish || finish}`,
          name: cardName,
          group_name: [item.setName, item.collectorNumber ? `#${item.collectorNumber}` : '', item.finish || finish, selected?.condition].filter(Boolean).join(' · ') || 'MTG single',
          quantity: selected?.stock || 0,
          price: selected?.price ?? null,
          currency: 'THB',
          priceSource: `Hobby Bugong · ${selected?.condition || 'condition unavailable'}`,
          url: slug ? `https://www.hobbybugong.com/shop/mtg/singles/${encodeURIComponent(slug)}` : 'https://www.hobbybugong.com/shop/mtg/singles',
          image_url: absoluteImageUrl(item.imageUrl),
          finish: item.finish || finish,
        });
      }
      page++;
    }
  }
  products.sort((a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity));
  return { products, checkedAt: new Date().toISOString(), source: 'Hobby Bugong public singles catalog' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, catalogLoadedAt: catalogLoadedAt ? new Date(catalogLoadedAt).toISOString() : null });
  }
  if (req.method === 'GET' && url.pathname === '/api/shops/detect') {
    try { return send(res, 200, await detectShopConnector(url.searchParams.get('url') || '')); }
    catch (error) { return send(res, 200, { connected: false, message: error.message || 'Automatic connection could not be verified. The shop can still be added for manual searching.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/shopify/search') {
    try { return send(res, 200, await searchConnectedShopify(url.searchParams.get('name') || '', url.searchParams.get('url') || '', url.searchParams.get('currency') || '')); }
    catch (error) { return send(res, 502, { error: error.message || 'Live shop lookup failed.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/lungji/search') {
    try { return send(res, 200, await searchLungJi(url.searchParams.get('name') || '')); }
    catch (error) { return send(res, 502, { error: error.message || 'Live catalog request failed.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/yannick/search') {
    try { return send(res, 200, await searchYannick(url.searchParams.get('name') || '')); }
    catch (error) { return send(res, 502, { error: error.message || 'Live Yannick lookup failed.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/power9/search') {
    try { return send(res, 200, await searchPower9(url.searchParams.get('name') || '')); }
    catch (error) { return send(res, 502, { error: error.message || 'Live Power 9 lookup failed.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/sabai/search') {
    try { return send(res, 200, await searchSabai(url.searchParams.get('name') || '')); }
    catch (error) { return send(res, 502, { error: error.message || 'Live Sabai Card lookup failed.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/hobbybugong/search') {
    try { return send(res, 200, await searchHobbyBugong(url.searchParams.get('name') || '')); }
    catch (error) { return send(res, 502, { error: error.message || 'Live Hobby Bugong lookup failed.' }); }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    return send(res, 200, html.toString('utf8'), 'text/html; charset=utf-8');
  }
  return send(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => console.log(`Mana Market live helper running at http://${HOST}:${PORT}`));

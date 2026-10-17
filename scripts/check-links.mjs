#!/usr/bin/env node
/**
 * Проверка локальных ссылок и ассетов в статическом HTML.
 *
 * Что проверяется:
 *  - файлы из href/src/poster реально существуют;
 *  - якоря вида href="#section" указывают на существующий id;
 *  - url(...) внутри <style> указывают на существующие файлы.
 *
 * Внешние URL (http/https), mailto:, tel:, data: и javascript: пропускаются.
 * "href=\"#\"" считается нормой (кнопки без навигации) и не является ошибкой.
 *
 * Использование: node scripts/check-links.mjs [file.html ...]
 * Код выхода: 1, если найдены битые ссылки.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const URL_ATTR_RE = /(href|src|poster|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const ID_RE = /\bid\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const SKIP_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const ASSET_EXT_RE = /\.(?:png|jpe?g|webp|avif|gif|svg|mp4|webm|ico|css|js|json|woff2?|ttf|otf|pdf)$/i;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function unquote(attr) {
  return attr.replace(/^['"]|['"]$/g, '').trim();
}

function checkFile(file) {
  const abs = resolve(ROOT, file);
  if (!existsSync(abs)) {
    console.error(`✖ ${file}: файл не найден`);
    return { errors: 1, warnings: 0 };
  }

  const rawHtml = readFileSync(abs, 'utf8');
  // Тело <script> не является разметкой: вырезаем его, сохраняя номера строк
  // (внутри JS встречаются "href = ...", которые иначе ловятся как ссылки).
  const html = rawHtml.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, body, close) => open + body.replace(/[^\n]/g, ' ') + close,
  );
  const dir = dirname(abs);
  const ids = new Set();
  for (const m of html.matchAll(ID_RE)) ids.add(m[2] ?? m[3] ?? m[4]);

  const seen = new Set();
  let errors = 0;
  let warnings = 0;

  const report = (level, line, message) => {
    const prefix = level === 'error' ? '✖' : '⚠';
    const stream = level === 'error' ? console.error : console.warn;
    stream(`${prefix} ${file}:${line} ${message}`);
  };

  const checkRef = (raw, kind, line) => {
    const value = raw.trim();
    if (!value || value === '#') return;
    if (SKIP_SCHEME_RE.test(value) || value.startsWith('data:')) {
      if (/^http:\/\//i.test(value)) {
        report('warn', line, `${kind}: insecure http:// ссылка — ${value}`);
        warnings++;
      }
      return;
    }

    // Якорь внутри страницы
    if (value.startsWith('#')) {
      const id = decodeURIComponent(value.slice(1));
      if (id && !ids.has(id)) {
        report('error', line, `${kind}: нет элемента с id="${id}"`);
        errors++;
      }
      return;
    }

    const [pathPart, hash] = value.split('#');
    const clean = decodeURI(pathPart.split('?')[0]);
    if (!clean) return;

    const target = resolve(dir, clean);
    if (!existsSync(target)) {
      report('error', line, `${kind}: файл не найден — ${value}`);
      errors++;
      return;
    }

    if (hash && clean.toLowerCase().endsWith('.html')) {
      const targetHtml = readFileSync(target, 'utf8');
      const targetIds = new Set();
      for (const m of targetHtml.matchAll(ID_RE)) targetIds.add(m[2] ?? m[3] ?? m[4]);
      if (!targetIds.has(decodeURIComponent(hash))) {
        report('warn', line, `${kind}: якорь #${hash} не найден в ${clean}`);
        warnings++;
      }
    }
  };

  // Атрибуты ссылок и ресурсов
  for (const m of html.matchAll(URL_ATTR_RE)) {
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    const key = `${m.index}:${m[1]}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = m[1].toLowerCase();
    const line = lineOf(html, m.index);

    if (name === 'srcset') {
      for (const candidate of value.split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) checkRef(url, 'srcset', line);
      }
      continue;
    }

    checkRef(value, name, line);
  }

  // url(...) внутри инлайн-стилей
  for (const block of html.matchAll(STYLE_RE)) {
    const offset = block.index + block[0].indexOf('>') + 1;
    for (const m of block[1].matchAll(CSS_URL_RE)) {
      const value = unquote(m[2]);
      if (!value || SKIP_SCHEME_RE.test(value) || value.startsWith('data:')) continue;
      if (!ASSET_EXT_RE.test(value.split(/[?#]/)[0])) continue;
      const target = resolve(dir, decodeURI(value.split(/[?#]/)[0]));
      if (!existsSync(target)) {
        report('error', lineOf(html, offset + m.index), `css url(): файл не найден — ${value}`);
        errors++;
      }
    }
  }

  return { errors, warnings };
}

if (files.length === 0) files.push('index.html');

let totalErrors = 0;
let totalWarnings = 0;
for (const file of files) {
  const { errors, warnings } = checkFile(file);
  totalErrors += errors;
  totalWarnings += warnings;
}

const checked = files.join(', ');
if (totalErrors > 0) {
  console.error(`\nПроверено: ${checked}. Ошибок: ${totalErrors}, предупреждений: ${totalWarnings}.`);
  process.exit(1);
}
console.log(`✔ ${checked}: битых ссылок не найдено (предупреждений: ${totalWarnings}).`);

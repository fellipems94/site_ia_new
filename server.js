// server.js
// Requisitos: Node 18+ (fetch nativo)
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// ===== Inicialização =====
dotenv.config(); // agora lê .env
const app = express();
app.use(express.json({ limit: '1mb' })); // evita payloads exagerados

// ===== CORS =====
// Use CORS_ORIGIN no .env (pode ser 1 origem ou lista separada por vírgula)
const rawOrigins = (process.env.CORS_ORIGIN || '').trim();
if (rawOrigins) {
  const allowed = rawOrigins.split(',').map(s => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin: (origin, cb) => {
        // Permite chamadas de ferramentas/health sem Origin e as origens na lista
        if (!origin || allowed.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
      },
      methods: ['POST', 'GET', 'OPTIONS'],
    })
  );
  app.options('*', cors());
}

// ===== Static (opcional, caso queira servir /public) =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ===== Config OpenAI (sempre via .env; nunca hardcode) =====
const apiKey = process.env.OPENAI_API_KEY; // (não exponha no cliente)
const MODEL_JSON = process.env.OPENAI_MODEL_JSON || 'gpt-4o-mini';
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || 'gpt-4o-mini';
if (!apiKey) {
  console.warn('⚠️  OPENAI_API_KEY não definido. Configure no .env ou no painel do Render.');
}

// ===== Helpers =====
function trunc(s, n) {
  s = (s ?? '').toString();
  return s.length > n ? s.slice(0, n) : s;
}

function enforceLimits(payload, limits) {
  const out = { titles: [], descriptions: [], sitelinks: [], highlights: [] };

  // Titles
  const t = Array.isArray(payload?.titles) ? payload.titles : [];
  for (let i = 0; i < (limits?.titles?.count ?? 15); i++) {
    out.titles[i] = trunc(t[i] ?? '', limits?.titles?.max ?? 30);
  }

  // Descriptions
  const d = Array.isArray(payload?.descriptions) ? payload.descriptions : [];
  for (let i = 0; i < (limits?.descriptions?.count ?? 4); i++) {
    out.descriptions[i] = trunc(d[i] ?? '', limits?.descriptions?.max ?? 90);
  }

  // Sitelinks
  const s = Array.isArray(payload?.sitelinks) ? payload.sitelinks : [];
  for (let i = 0; i < (limits?.sitelinks?.count ?? 4); i++) {
    const item = s[i] || {};
    out.sitelinks[i] = {
      text:  trunc(item.text  ?? '', limits?.sitelinks?.text  ?? 25),
      desc1: trunc(item.desc1 ?? '', limits?.sitelinks?.desc1 ?? 35),
      desc2: trunc(item.desc2 ?? '', limits?.sitelinks?.desc2 ?? 35),
    };
  }

  // Highlights
  const h = Array.isArray(payload?.highlights) ? payload.highlights : [];
  for (let i = 0; i < (limits?.highlights?.count ?? 8); i++) {
    out.highlights[i] = trunc(h[i] ?? '', limits?.highlights?.max ?? 25);
  }

  return out;
}

// ===== Prompts =====
function promptFill(etapa1, limits) {
  const {
    productName, country, language,
    productValue, productCurrency,
    monetaryDiscount, discountCurrency,
    percentageDiscount
  } = (etapa1 || {});

  return `
Você é um redator especializado em Google Ads (2025), com foco em localização por país/idioma e conformidade com políticas do Google Ads 2025.

OBJETIVO:
Gerar ativos de anúncio (títulos, descrições, sitelinks e frases destaque) para o produto abaixo, no padrão de vendas do país e idioma informados. Textos criativos, claros, persuasivos e alinhados ao estilo Google Ads (sem apelação).

REGRAS GERAIS (SIGA À RISCA):
- Responda SOMENTE com um JSON VÁLIDO, sem texto antes ou depois.
- Idioma de saída: ${language} (variante local de ${country}).
- Adapte tom e vocabulário ao país/idioma.
- Conformidade: políticas Google Ads 2025; evite promessas absolutas/enganosas; sem emojis; no máx. 1 "!" por item.
- Estilo Google Ads: benefício + proposta de valor + CTA moderado.
- Use preço/descontos quando fizer sentido:
  • Preço: ${productCurrency} ${productValue ?? 'n/a'}
  • Desconto monetário: ${discountCurrency} ${monetaryDiscount ?? 'n/a'}
  • Desconto percentual: ${percentageDiscount ?? 'n/a'}%
- Varie os textos entre si e respeite exatamente os limites de caracteres.

LIMITES:
- titles: ${limits?.titles?.count ?? 15} itens, cada um ≤ ${limits?.titles?.max ?? 30} caracteres.
- descriptions: ${limits?.descriptions?.count ?? 4} itens, cada um ≤ ${limits?.descriptions?.max ?? 90} caracteres.
- sitelinks (${limits?.sitelinks?.count ?? 4} itens): text ≤ ${limits?.sitelinks?.text ?? 25}, desc1 ≤ ${limits?.sitelinks?.desc1 ?? 35}, desc2 ≤ ${limits?.sitelinks?.desc2 ?? 35}.
- highlights: ${limits?.highlights?.count ?? 8} itens, cada um ≤ ${limits?.highlights?.max ?? 25} caracteres.

FORMATO DE SAÍDA (JSON EXATO):
{
  "titles": string[${limits?.titles?.count ?? 15}],
  "descriptions": string[${limits?.descriptions?.count ?? 4}],
  "sitelinks": { "text": string, "desc1": string, "desc2": string }[${limits?.sitelinks?.count ?? 4}],
  "highlights": string[${limits?.highlights?.count ?? 8}]
}

DADOS DO PRODUTO (ENTRADA):
${JSON.stringify(etapa1, null, 2)}
`.trim();
}

function promptVariant(etapa1, kind, index, limits) {
  const limit = {
    title: limits?.titles?.max ?? 30,
    description: limits?.descriptions?.max ?? 90,
    sitelink_text: limits?.sitelinks?.text ?? 25,
    sitelink_desc1: limits?.sitelinks?.desc1 ?? 35,
    sitelink_desc2: limits?.sitelinks?.desc2 ?? 35,
    highlight: limits?.highlights?.max ?? 25
  }[kind] || 90;

  return `
Você é um redator de Google Ads (2025). Gere APENAS UMA variação para "${kind}" (índice ${index}):
- País: ${etapa1?.country} | Idioma: ${etapa1?.language}
- Limite: ≤ ${limit} caracteres
- Estilo: benefício + valor + CTA moderado; sem violar políticas Google Ads 2025; sem emojis; no máx. 1 "!"
- Considere preço/descontos quando fizer sentido (${etapa1?.productCurrency} ${etapa1?.productValue}; ${etapa1?.discountCurrency} ${etapa1?.monetaryDiscount} / ${etapa1?.percentageDiscount}%)

Saída: SOMENTE o texto final (sem aspas e sem JSON).
Produto: ${etapa1?.productName}
`.trim();
}

// ===== Chamada OpenAI =====
async function chamarLLMJson(prompt) {
  if (!apiKey) throw new Error('OPENAI_API_KEY ausente');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_JSON,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Responda sempre de forma objetiva, conforme políticas Google Ads 2025.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!r.ok) {
    const errTxt = await r.text().catch(() => '');
    throw new Error(`OpenAI erro: ${r.status} ${errTxt}`);
  }

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM sem conteúdo');

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}$/);
    if (!match) throw new Error('Resposta da IA não é JSON válido');
    return JSON.parse(match[0]);
  }
}

async function chamarLLMText(prompt) {
  if (!apiKey) throw new Error('OPENAI_API_KEY ausente');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_TEXT,
      temperature: 0.5,
      messages: [
        { role: 'system', content: 'Responda apenas com o texto pedido, sem aspas.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!r.ok) {
    const errTxt = await r.text().catch(() => '');
    throw new Error(`OpenAI erro: ${r.status} ${errTxt}`);
  }

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('LLM sem conteúdo');
  return content;
}

// ===== Endpoints =====
app.post('/api/ai-fill', async (req, res) => {
  try {
    const { etapa1, limits } = req.body || {};
    if (!etapa1?.productName) return res.status(400).json({ error: 'FALTAM_DADOS', field: 'productName' });

    const payload = await chamarLLMJson(promptFill(etapa1, limits));
    const safe = enforceLimits(payload, limits);
    // text/plain evita proxies que mexem no JSON
    res.type('text/plain').send(JSON.stringify(safe));
  } catch (err) {
    console.error('AI_FILL_FAIL:', err.message);
    res.status(500).json({ error: 'AI_FILL_FAIL', detail: err.message });
  }
});

app.post('/api/ai-variant', async (req, res) => {
  try {
    const { etapa1, kind, index, limits } = req.body || {};
    if (!etapa1?.productName) return res.status(400).json({ error: 'FALTAM_DADOS', field: 'productName' });

    const text = await chamarLLMText(promptVariant(etapa1, kind, index, limits));
    const maxByKind = {
      title: limits?.titles?.max ?? 30,
      description: limits?.descriptions?.max ?? 90,
      sitelink_text: limits?.sitelinks?.text ?? 25,
      sitelink_desc1: limits?.sitelinks?.desc1 ?? 35,
      sitelink_desc2: limits?.sitelinks?.desc2 ?? 35,
      highlight: limits?.highlights?.max ?? 25
    }[kind] || 90;

    res.type('text/plain').send(trunc(text, maxByKind));
  } catch (err) {
    console.error('AI_VARIANT_FAIL:', err.message);
    res.status(500).json({ error: 'AI_VARIANT_FAIL', detail: err.message });
  }
});

// ===== Healthcheck =====
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    model_json: MODEL_JSON,
    model_text: MODEL_TEXT,
    cors_enabled: Boolean(rawOrigins),
  });
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});

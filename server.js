// server.js
// Requisitos: Node 18+ (tem fetch nativo)
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// ===== Inicialização =====
const app = express();
app.use(express.json());

// CORS (se for servir o HTML de outro domínio). 
// Se não precisar, pode remover.
const allowOrigin = null;
if (allowOrigin) {
  app.use(cors({ origin: allowOrigin, methods: ['POST', 'GET'], credentials: false }));
}

// Static para servir sua página da pasta /public
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ===== SUA CHAVE DIRETO AQUI (⚠️ inseguro, use só local/teste) =====
const apiKey = "S9MRT80WWWctDBRGliuV6w0gzb8s4qYbVqeY4U5Gif3KnyOJEQLLXs-fhgy2d96ULK4HrqlVZ6T3BlbkFJQyTlNxnlJZTW_7ZDVS0RAgkdNqM_1Pmu5Xc1ybsGhMK6vEjmDYvzVj7faD-GpeY2khILCwyGgA";

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

REGRAS:
- Apenas JSON válido.
- Idioma: ${language} (${country}).
- Respeite limites de caracteres (títulos ≤30, descrições ≤90, etc).
- Use preço e descontos se fizer sentido:
  • Preço: ${productCurrency} ${productValue}
  • Desconto: ${discountCurrency} ${monetaryDiscount} / ${percentageDiscount}%
- Estilo Google Ads: benefício + valor + CTA moderado.

FORMATO DE SAÍDA (JSON):
{
  "titles": string[15],
  "descriptions": string[4],
  "sitelinks": { "text": string, "desc1": string, "desc2": string }[4],
  "highlights": string[8]
}

DADOS:
${JSON.stringify(etapa1, null, 2)}
`.trim();
}

function promptVariant(etapa1, kind, index, limits) {
  return `
Gere apenas 1 variação para "${kind}" (índice ${index}) respeitando o limite de caracteres.
Produto: ${etapa1?.productName}
País: ${etapa1?.country} | Idioma: ${etapa1?.language}
Desconto: ${etapa1?.discountCurrency} ${etapa1?.monetaryDiscount} / ${etapa1?.percentageDiscount}%

Saída: apenas o texto final.
`.trim();
}

// ===== Chamada OpenAI =====
async function chamarLLMJson(prompt) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Responda apenas em JSON válido.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content;
}

async function chamarLLMText(prompt) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: 'Responda apenas com o texto pedido, sem aspas.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim();
}

// ===== Endpoints =====
app.post('/api/ai-fill', async (req, res) => {
  try {
    const { etapa1, limits } = req.body || {};
    const prompt = promptFill(etapa1, limits);
    const jsonStr = await chamarLLMJson(prompt);
    const payload = JSON.parse(jsonStr);
    res.json(enforceLimits(payload, limits));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI_FILL_FAIL' });
  }
});

app.post('/api/ai-variant', async (req, res) => {
  try {
    const { etapa1, kind, index, limits } = req.body || {};
    const prompt = promptVariant(etapa1, kind, index, limits);
    const text = await chamarLLMText(prompt);
    res.send(trunc(text, 90));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI_VARIANT_FAIL' });
  }
});

// ===== Start =====
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

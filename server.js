const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const apiKey = process.env.AZURE_OPENAI_API_KEY;
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
const gaMeasurementId = process.env.GA4_MEASUREMENT_ID || '';
const clarityProjectId = process.env.MICROSOFT_CLARITY_PROJECT_ID || '';

const hasAzureConfig = Boolean(endpoint && apiKey && deployment);

const FIELD_HINTS = [
    'name',
    'email',
    'phone',
    'website',
    'linkedin',
    'github',
    'company',
    'team',
    'role',
    'title',
    'location',
    'background',
    'experience',
    'customer',
    'problem',
    'solution',
    'market',
    'revenue',
    'traction',
    'funding',
    'why',
    'how',
    'what',
    'when',
    'where',
    'describe',
    'share',
    'tell us',
    'upload',
    'portfolio',
    'resume',
];

const NOISE_PATTERNS = [
    'log in',
    'sign in',
    'copyright',
    'all rights reserved',
    'menu',
    'footer',
    'cookie',
    'privacy',
    'terms',
    'subscribe',
    'speaker',
    'speakers',
    'agenda',
    'schedule',
    'location',
    'apply now',
    'live in the future',
];

function normalizeWhitespace(value) {
    return value
        .replace(/\r/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function cleanupQuestion(value) {
    return value
        .replace(/\s+/g, ' ')
        .replace(/^[*•·\-–—\d.)\s]+/, '')
        .replace(/\s*[:\-–—]\s*$/, '')
        .replace(/\s+\?/g, '?')
        .trim();
}

function isNoiseLine(line) {
    const lower = line.toLowerCase();
    if (!line || line.length < 3 || line.length > 220) return true;
    if (NOISE_PATTERNS.some((pattern) => lower.includes(pattern))) return true;
    if (/^[\W_]+$/.test(line)) return true;
    if (line === line.toUpperCase() && !line.endsWith('?')) return true;
    if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(line)) return true;
    if (/^(san francisco|sf\.ca|july \d{1,2}|\d{4})$/i.test(line)) return true;
    return false;
}

function looksLikeFieldPrompt(line) {
    const lower = line.toLowerCase();
    if (line.endsWith('?')) return true;
    if (line.includes('(optional)') || line.includes('(required)')) return true;
    if (/^(why|what|when|where|how|who)\b/i.test(line)) return true;
    if (/:$/.test(line)) return true;
    if (/^(briefly |describe |share |tell us |upload |list )/i.test(line)) return true;
    if (/[.!]$/.test(line)) return false;
    if (line.split(' ').length > 12) return false;
    return FIELD_HINTS.some((hint) => lower.includes(hint));
}

function dedupeQuestions(values) {
    const seen = new Set();
    const results = [];

    for (const value of values) {
        const cleaned = cleanupQuestion(value);
        if (!cleaned || isNoiseLine(cleaned) || !looksLikeFieldPrompt(cleaned)) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(cleaned);
    }

    return results;
}

function localFallback(rawText) {
    const normalized = normalizeWhitespace(rawText);
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const stitched = [];
    for (let index = 0; index < lines.length; index += 1) {
        const current = lines[index];
        const next = lines[index + 1];

        if (looksLikeFieldPrompt(current) || !next) {
            stitched.push(current);
            continue;
        }

        if (
            current.length < 80 &&
            next.length < 140 &&
            !looksLikeFieldPrompt(next) &&
            !/[.!?]$/.test(current)
        ) {
            stitched.push(`${current} ${next}`);
            index += 1;
            continue;
        }

        stitched.push(current);
    }

    return dedupeQuestions(stitched);
}

function parseAiQuestions(content) {
    const parsed = JSON.parse(content);
    const questions = Array.isArray(parsed) ? parsed : parsed.questions;
    return Array.isArray(questions) ? dedupeQuestions(questions) : [];
}

function createDocTemplate(questions) {
    return questions
        .map((question) => `${question}\n[Your answer here]`)
        .join('\n\n');
}

async function callAzureChat(messages) {
    const cleanEndpoint = endpoint.replace(/\/+$/, '');
    const v1Url = `${cleanEndpoint}/openai/v1/chat/completions`;
    const legacyUrl = `${cleanEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

    const headers = {
        'Content-Type': 'application/json',
        'api-key': apiKey,
    };
    const body = JSON.stringify({
        model: deployment,
        messages,
        temperature: 0.1,
        response_format: { type: 'json_object' },
    });

    let response = await fetch(v1Url, {
        method: 'POST',
        headers,
        body,
    });

    if (!response.ok && response.status === 404) {
        response = await fetch(legacyUrl, {
            method: 'POST',
            headers,
            body,
        });
    }

    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Azure OpenAI error ${response.status}: ${details}`);
    }

    const payload = await response.json();
    return payload.choices?.[0]?.message?.content?.trim() || '{"questions":[]}';
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/config.js', (_req, res) => {
    res.type('application/javascript');
    res.send(
        `window.__APP_CONFIG__ = ${JSON.stringify({
            gaMeasurementId,
            clarityProjectId,
        })};`
    );
});

app.get('/api/health', (_req, res) => {
    res.json({
        ok: true,
        provider: 'azure-openai',
        modelConfigured: hasAzureConfig,
        analyticsConfigured: {
            ga4: Boolean(gaMeasurementId),
            clarity: Boolean(clarityProjectId),
        },
    });
});

app.post('/api/clean', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    const normalizedInput = normalizeWhitespace(text).slice(0, 25000);
    const fallbackQuestions = localFallback(normalizedInput);

    if (!hasAzureConfig) {
        return res.json({
            questions: fallbackQuestions,
            template: createDocTemplate(fallbackQuestions),
            note: 'Azure OpenAI is not configured, used local extraction',
        });
    }

    try {
        const responseText = await callAzureChat([
            {
                role: 'system',
                content: [
                    'You extract form fields from messy pasted text.',
                    'Return valid JSON in the shape {"questions":["..."]}.',
                    'Keep only application questions, field labels, and short helper text needed to answer.',
                    'Remove navigation, speaker bios, marketing copy, dates, locations, and duplicate lines.',
                    'Rewrite fragments into clean field prompts suitable for a Google Doc template.',
                ].join(' '),
            },
            {
                role: 'user',
                content: `Convert this pasted content into a clean form template.\n\nTEXT:\n${normalizedInput}`,
            },
        ]);
        const aiQuestions = parseAiQuestions(responseText);
        const questions = aiQuestions.length > 0 ? aiQuestions : fallbackQuestions;

        return res.json({
            questions,
            template: createDocTemplate(questions),
            source: aiQuestions.length > 0 ? 'azure-openai' : 'fallback',
        });
    } catch (error) {
        console.warn('Azure AI failed, using local fallback:', error.message);
        return res.json({
            questions: fallbackQuestions,
            template: createDocTemplate(fallbackQuestions),
            source: 'fallback',
            note: 'AI failed, used local extraction',
        });
    }
});

app.post('/api/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    if (process.env.VERCEL) {
        return res.status(501).json({
            error: 'URL scraping is disabled on Vercel',
            details: 'Deploy this route on a full Node host or local machine with Playwright installed.',
        });
    }

    let browser;
    try {
        const { chromium } = require('playwright');
        browser = await chromium.launch({
            headless: true,
            args: ['--disable-animations', '--no-sandbox'],
        });
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

        const extractedData = await page.evaluate(() => {
            const results = [];
            const seenText = new Set();

            const addResult = (text) => {
                if (!text) return;
                const trimmed = text.replace(/\s+/g, ' ').trim();
                if (trimmed.length > 2 && !seenText.has(trimmed)) {
                    seenText.add(trimmed);
                    results.push(trimmed);
                }
            };

            const elements = document.querySelectorAll(
                'h1, h2, h3, h4, h5, h6, label, legend, .question, [role="heading"], [aria-label], [placeholder]'
            );
            elements.forEach((el) => addResult(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')));

            const inputs = document.querySelectorAll('input, textarea, select');
            inputs.forEach((input) => {
                addResult(input.getAttribute('placeholder'));
                addResult(input.getAttribute('aria-label'));
                addResult(input.getAttribute('name'));

                if (input.labels) {
                    Array.from(input.labels).forEach((label) => addResult(label.innerText));
                }

                if (input.type === 'radio' || input.type === 'checkbox') {
                    const sibling = input.nextElementSibling;
                    if (sibling && sibling.innerText) {
                        addResult(sibling.innerText);
                    } else if (input.parentElement && input.parentElement.innerText) {
                        addResult(input.parentElement.innerText);
                    }
                }
            });

            return results;
        });

        const questions = dedupeQuestions(extractedData);
        return res.json({ questions, template: createDocTemplate(questions) });
    } catch (error) {
        console.error('Scraping error:', error);
        return res.status(500).json({ error: 'Failed to scrape URL', details: error.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

module.exports = app;

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

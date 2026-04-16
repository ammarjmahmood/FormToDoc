const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

app.post('/api/clean', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });

    // Local Fallback Heuristic (in case AI fails)
    const localFallback = (rawText) => {
        const lines = rawText.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 5 && l.length < 300);
        
        const noise = ['log in', 'sign in', 'copyright', 'all rights reserved', 'home', 'menu', 'footer'];
        return [...new Set(lines.filter(line => {
            const lower = line.toLowerCase();
            if (line.endsWith('?')) return true;
            if (noise.some(n => lower.includes(n))) return false;
            if (line.includes('(edit)')) return true; // Keep lines that look like questions with current answers
            return line.split(' ').length > 2;
        }))];
    };

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `
            You are a form extraction specialist. Process this text/fragment:
            
            RULES:
            1. Extract every unique question, label, or field description.
            2. Remove personal data (e.g., if you see "Name: Ammar", just extract "Name").
            3. Clean up navigation noise, buttons, and login links.
            4. If a hint exists (e.g., "YYYY-MM-DD"), keep it in brackets.
            5. Output ONLY a valid JSON array of strings.
            
            TEXT:
            ${text.substring(0, 20000)}
        `;

        const result = await model.generateContent(prompt);
        let responseText = result.response.text();
        responseText = responseText.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
        
        const cleanedQuestions = JSON.parse(responseText);
        res.json({ questions: Array.isArray(cleanedQuestions) ? cleanedQuestions : localFallback(text) });
    } catch (error) {
        console.warn('AI failed, using local fallback:', error.message);
        res.json({ questions: localFallback(text), note: "AI failed, used local extraction" });
    }
});

app.post('/api/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    let browser;
    try {
        browser = await chromium.launch({
            // Headless mode is default, it works well.
            // Disable animations for faster scraping
            args: ['--disable-animations']
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

        // Evaluate the page and extract potential questions
        const extractedData = await page.evaluate(() => {
            const results = [];
            const seenText = new Set();
            
            const addResult = (text) => {
                if (text) {
                    text = text.trim();
                    // Filter out short words and duplicates
                    if (text.length > 2 && !seenText.has(text)) {
                        seenText.add(text);
                        results.push(text);
                    }
                }
            };

            // 1. Extract headings, labels, legends
            const elements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, label, legend, .question, [role="heading"]');
            elements.forEach(el => addResult(el.innerText));

            // 2. Extract input placeholders and aria-labels if not already seen
            const inputs = document.querySelectorAll('input, textarea, select');
            inputs.forEach(input => {
                addResult(input.getAttribute('placeholder'));
                addResult(input.getAttribute('aria-label'));
                
                // If it's a checkbox or radio, try to get adjacent text
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

        res.json({ questions: extractedData });
    } catch (error) {
        console.error('Scraping error:', error);
        res.status(500).json({ error: 'Failed to scrape URL', details: error.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

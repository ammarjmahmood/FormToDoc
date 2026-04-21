const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.AZURE_OPENAI_ENDPOINT = '';
process.env.AZURE_OPENAI_API_KEY = '';
process.env.AZURE_OPENAI_DEPLOYMENT = '';
process.env.AZURE_OPENAI_API_VERSION = '';

const app = require('../server');

function startServer() {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, () => resolve(server));
    });
}

test('clean endpoint strips marketing copy from pasted page text', async () => {
    const server = await startServer();
    const { port } = server.address();

    try {
        const sample = [
            'STARTUP SCHOOL 2026',
            'JUL 25-27',
            'SF.CA',
            "Startup School is YC's flagship founder program.",
            'Jessica Hsu',
            'What are you building?',
            'Describe your product in one sentence',
            'Company name',
            'Website URL',
            'Why did you decide to apply?',
            'How many founders are on the team?',
            'LIVE IN THE FUTURE THEN BUILD WHAT\'S MISSING',
        ].join('\n');

        const response = await fetch(`http://127.0.0.1:${port}/api/clean`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: sample }),
        });

        assert.equal(response.status, 200);
        const data = await response.json();

        assert.deepEqual(data.questions, [
            'What are you building?',
            'Describe your product in one sentence',
            'Company name',
            'Website URL',
            'Why did you decide to apply?',
            'How many founders are on the team?',
        ]);
        assert.match(data.template, /\[Your answer here\]/);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
